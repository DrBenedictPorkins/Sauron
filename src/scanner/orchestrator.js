const { scanAll } = require('./index');
const { analyze } = require('../analyzer');
const { summarize, needsSummaryRefresh } = require('../summarizer');
const db = require('../db');

let scan = null;

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
  };
}

function requestStop() {
  if (scan) scan.stopRequested = true;
}

async function runScan(cfg, type = 'quick', { projectIds } = {}) {
  if (scan) {
    return { skipped: true, reason: 'Scan already in progress' };
  }

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
    // Phase 1: discover projects
    let projectList;
    if (projectIds && projectIds.length > 0) {
      const idSet = new Set(projectIds);
      const existing = db.getProjects({ includeIgnored: true });
      projectList = existing
        .filter(p => idSet.has(p.id))
        .map(p => ({ path: p.path, name: p.name, group: p.group_name, rootLabel: p.root_label, type: p.type }));
    } else {
      // Both quick and deep start with full directory crawl
      projectList = scanAll(cfg);
    }

    scan.projectsTotal = projectList.length;
    scan.phase = 'analyzing';

    // Phase 2: analyze each project (git metadata, integrations, etc.)
    const analyzed = [];
    for (const p of projectList) {
      if (scan.stopRequested) break;
      scan.currentProjectName = p.name;
      scan.projectsCurrent++;

      const result = await analyze(p);
      db.upsertProject(result.dbFields);
      analyzed.push(result);
    }

    if (scan.stopRequested) {
      db.finishScanRun(runId, analyzed.length, 0);
      return { success: true, stopped: true, found: analyzed.length };
    }

    // Phase 3: AI summaries — ONLY on deep scan
    let successCount = 0;
    if (type === 'deep') {
      scan.phase = 'summarizing';
      const maxSummaries = cfg.maxSummariesPerScan || 50;
      const toSummarize = analyzed
        .filter(({ dbFields, transient }) => {
          const existing = db.getProject(dbFields.id);
          return needsSummaryRefresh(existing, transient.commitHash);
        })
        // Most recent projects first — they matter most
        .sort((a, b) => (b.dbFields.last_commit_date || 0) - (a.dbFields.last_commit_date || 0))
        .slice(0, maxSummaries);

      scan.summariesTotal = toSummarize.length;

      for (const { dbFields, transient } of toSummarize) {
        if (scan.stopRequested) break;
        scan.summariesCurrent++;
        scan.currentProjectName = dbFields.name;

        const proj = db.getProject(dbFields.id);
        if (!proj) continue;

        const result = await summarize(proj, transient);
        if (result) {
          scan.inputTokens += result.inputTokens;
          scan.outputTokens += result.outputTokens;
          scan.estimatedCost += result.cost;
          successCount++;
        }
      }
    }

    const tokenUsage = {
      inputTokens: scan.inputTokens,
      outputTokens: scan.outputTokens,
      estimatedCost: scan.estimatedCost,
      summariesGenerated: successCount,
    };

    db.finishScanRun(runId, analyzed.length, successCount, tokenUsage);
    return { success: true, found: analyzed.length, summarized: successCount, tokenUsage };
  } catch (err) {
    console.error('Scan error:', err);
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
