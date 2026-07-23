const { scanAll } = require('./index');
const { analyze, checkDeps } = require('../analyzer');
const { summarize, needsSummaryRefresh } = require('../summarizer');
const db = require('../db');

let scan = null;
const activeProjectIds = new Set();

function getProgress() {
  if (!scan) return null;
  return {
    phase: scan.phase,
    type: scan.type,
    projectsCurrent: scan.projectsCurrent,
    projectsTotal: scan.projectsTotal,
    currentProjectName: scan.currentProjectName,
    summariesCurrent: scan.summariesCurrent,
    summariesTotal: scan.summariesTotal,
    inputTokens: scan.inputTokens,
    outputTokens: scan.outputTokens,
    estimatedCost: scan.estimatedCost,
    activeProjectIds: [...activeProjectIds],
  };
}

function requestStop() {
  if (scan) scan.stopRequested = true;
}

async function runScan(cfg, type = 'quick', { projectIds, forceRegenerate = false } = {}) {
  if (scan) return { skipped: true, reason: 'Scan already in progress' };
  const deep = type !== 'quick';

  scan = {
    type,
    phase: 'discovering',
    projectsCurrent: 0,
    projectsTotal: 0,
    currentProjectName: null,
    summariesCurrent: 0,
    summariesTotal: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    stopRequested: false,
  };

  const runId = db.startScanRun(type);

  try {
    // Phase 1: discover
    let projectList;
    if (projectIds && projectIds.length > 0) {
      const idSet = new Set(projectIds);
      const existing = db.getProjects({ includeIgnored: true });
      projectList = existing
        .filter(p => idSet.has(p.id))
        .map(p => ({ path: p.path, name: p.name, group: p.group_name, rootLabel: p.root_label, type: p.type }));
    } else {
      projectList = scanAll(cfg);
    }

    scan.projectsTotal = projectList.length;
    scan.phase = 'analyzing';

    // Phase 2: analyze (git metadata, integrations, languages)
    const analyzed = [];
    for (const p of projectList) {
      if (scan.stopRequested) break;
      scan.currentProjectName = p.name;
      scan.projectsCurrent++;
      activeProjectIds.add(p.path); // use path as temp key before we have dbFields

      const result = await analyze(p, cfg);
      db.upsertProject(result.dbFields);
      activeProjectIds.delete(p.path);
      activeProjectIds.add(result.dbFields.id);
      analyzed.push(result);
    }

    if (scan.stopRequested) {
      activeProjectIds.clear();
      db.finishScanRun(runId, analyzed.length, 0);
      return { success: true, stopped: true, found: analyzed.length };
    }

    // Phase 3: dep staleness check — skip if same commit hash
    scan.phase = 'checking deps';
    for (const { dbFields, transient } of analyzed) {
      if (scan.stopRequested) break;
      const proj = db.getProject(dbFields.id);
      if (proj && proj.deps_commit_hash && proj.deps_commit_hash === transient.commitHash) {
        activeProjectIds.delete(dbFields.id);
        continue;
      }
      scan.currentProjectName = dbFields.name;
      const staleDeps = checkDeps(dbFields.path, dbFields.type);
      db.updateDeps(dbFields.id, staleDeps, transient.commitHash);
      activeProjectIds.delete(dbFields.id);
    }

    // Phase 4: AI summaries — only for Deep Scans (always an explicit project
    // selection made by the user via the confirmation checklist). Re-check
    // needsSummaryRefresh here in case state changed since the dialog opened,
    // unless force-regenerating (the single-project explicit trigger).
    let toSummarize = [];
    if (deep) {
      scan.phase = 'summarizing';
      toSummarize = analyzed.filter(({ dbFields, transient }) =>
        projectIds.includes(dbFields.id) &&
        needsSummaryRefresh(db.getProject(dbFields.id), transient.commitHash, forceRegenerate));
    }

    scan.summariesTotal = toSummarize.length;
    let successCount = 0;

    for (const { dbFields, transient } of toSummarize) {
      if (scan.stopRequested) break;
      scan.summariesCurrent++;
      scan.currentProjectName = dbFields.name;
      activeProjectIds.add(dbFields.id);

      const proj = db.getProject(dbFields.id);
      if (!proj) { activeProjectIds.delete(dbFields.id); continue; }

      const result = await summarize(proj, transient);
      if (result) {
        scan.inputTokens += result.inputTokens;
        scan.outputTokens += result.outputTokens;
        scan.estimatedCost += result.cost;
        successCount++;
      }
      activeProjectIds.delete(dbFields.id);
    }

    activeProjectIds.clear();
    db.finishScanRun(runId, analyzed.length, successCount, {
      inputTokens: scan.inputTokens,
      outputTokens: scan.outputTokens,
      estimatedCost: scan.estimatedCost,
      summariesGenerated: successCount,
    });
    return { success: true, found: analyzed.length, summarized: successCount };
  } catch (err) {
    console.error('Scan error:', err);
    activeProjectIds.clear();
    db.finishScanRun(runId, 0, 0);
    return { success: false, error: err.message };
  } finally {
    scan = null;
  }
}

function isScanInProgress() {
  return scan !== null;
}

module.exports = { runScan, isScanInProgress, getProgress, requestStop };
