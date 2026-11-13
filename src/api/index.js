const express = require('express');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { MODEL } = require('../models');
const { runScan, isScanInProgress, getProgress, requestStop } = require('../scanner/orchestrator');
const { analyze } = require('../analyzer');
const { summarize } = require('../summarizer');
const { chat, globalChat, clearSession, condenseSession } = require('../chat');
const docgen = require('../docgen');
const { linksFor } = require('../links');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../../ui')));

  // Projects
  app.get('/api/projects', (req, res) => {
    const projects = db.getProjects({ includeIgnored: req.query.includeIgnored === 'true' });
    res.json(projects.map(formatProject));
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    res.json(formatProject(project));
  });

  app.post('/api/projects/:id/ignore', (req, res) => {
    db.setIgnored(req.params.id, req.body.ignored !== false);
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/label', (req, res) => {
    db.setUserLabel(req.params.id, req.body.label || null);
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/deep-scan-ignore', (req, res) => {
    db.setDeepScanIgnored(req.params.id, req.body.ignored !== false);
    res.json({ ok: true });
  });

  // On-demand AI summary for a single project (used when opening a project that
  // has no cached summary — e.g. a dormant project skipped by auto-scans).
  app.post('/api/projects/:id/summarize', async (req, res) => {
    const p = db.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    try {
      const cfg = config.load();
      const scanned = { path: p.path, name: p.name, group: p.group_name, rootLabel: p.root_label, type: p.type };
      const { dbFields, transient } = await analyze(scanned, cfg);
      db.upsertProject(dbFields);
      const proj = db.getProject(p.id);
      const result = await summarize(proj, transient);
      res.json({ summary: result?.summary || proj.summary || null, status: dbFields.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/links', (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const byId = new Map(db.getProjects({ includeIgnored: true }).map(p => [p.id, p]));
    res.json({
      checkedAt: project.links_checked_at || null,
      outdated: !!(project.links_checked_at && project.commit_hash && project.commit_hash !== project.links_commit_hash),
      links: linksFor(project.id, db.getLinksTouching(project.id), byId),
    });
  });

  // Doc drafts — generated into a temp dir, never into the project. The UI
  // discards them when the dialog closes; copying one into the repo is manual.
  app.post('/api/projects/:id/generate-docs', async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    const unknown = files.filter(f => !docgen.KINDS[f]);
    if (files.length === 0 || unknown.length > 0) {
      return res.status(400).json({ error: `Ask for one or both of: ${Object.keys(docgen.KINDS).join(', ')}.` });
    }
    try {
      res.json(await docgen.generateDocs(project, files));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id/drafts', (req, res) => {
    res.json({ files: docgen.listDrafts(req.params.id) });
  });

  app.get('/api/projects/:id/drafts/:name', (req, res) => {
    const content = docgen.readDraft(req.params.id, req.params.name);
    if (content === null) return res.status(404).json({ error: 'No such draft' });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.send(content);
  });

  app.delete('/api/projects/:id/drafts', (req, res) => {
    docgen.discardDrafts(req.params.id);
    res.json({ ok: true });
  });

  // Scan
  app.post('/api/scan', (req, res) => {
    if (isScanInProgress()) {
      return res.status(409).json({ error: 'Scan already in progress' });
    }
    // findLinks defaults off here so a bare API call never spends on it; the UI
    // sends it ticked by default.
    const { projectIds, type = 'quick', forceRegenerate = false, findLinks = false } = req.body;

    if (type === 'deep') {
      if (!projectIds || projectIds.length === 0) {
        return res.status(400).json({ error: 'Deep Scan requires an explicit project selection — use a bucket or project scan.' });
      }
      const cap = config.load().maxSummariesPerScan || 50;
      if (projectIds.length > cap) {
        return res.status(400).json({ error: `Selection of ${projectIds.length} exceeds the per-scan cap of ${cap}. Deselect some projects and try again.` });
      }
    }

    const label = type === 'deep' ? `deep scan (${projectIds.length} projects)` : (projectIds ? `quick scan (${projectIds.length} projects)` : 'quick scan (full fleet)');
    res.json({ ok: true, message: `${label} started` });
    runScan(config.load(), type, { projectIds, forceRegenerate, findLinks: type === 'deep' && !!findLinks }).catch(console.error);
  });

  // Everything the Quick Scan confirmation needs to answer "do I even need to
  // run this?" — when the last full-fleet Quick Scan finished, what it found,
  // how long one usually takes, and which directories are about to be walked.
  app.get('/api/scan/quick-preview', (_req, res) => {
    const cfg = config.load();
    res.json({
      scanRoots: cfg.scanRoots,
      ignore: cfg.ignore,
      projectsTracked: db.countProjects(),
      ignoredCount: db.countIgnoredProjects(),
      lastFleetQuickScan: db.getLastFleetQuickScan() || null,
      lastAnyScan: db.getRecentScanRun() || null,
      avgDurationMs: db.getAverageQuickScanDuration(),
    });
  });

  app.get('/api/scan/cost-estimate', (_req, res) => {
    res.json({ avgCostPerSummary: db.getAverageSummaryCost(), avgCostPerLinkScan: db.getAverageLinkCost() });
  });

  app.get('/api/scan/status', (_req, res) => {
    const progress = getProgress();
    res.json({
      inProgress: isScanInProgress(),
      isBackground: progress?.type === 'background',
      progress,
      lastRun: db.getRecentScanRun() || null,
    });
  });

  app.post('/api/scan/stop', (_req, res) => {
    if (!isScanInProgress()) {
      return res.status(400).json({ error: 'No scan in progress' });
    }
    requestStop();
    res.json({ ok: true });
  });

  // Global chat (must be before /:projectId routes)
  app.post('/api/chat/global', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    const projects = db.getProjects({ includeIgnored: false });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      for await (const event of globalChat(projects, message, db.getAllLinks())) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    }
    res.end();
  });

  app.post('/api/chat/global/clear', (req, res) => {
    clearSession('global');
    res.json({ ok: true });
  });

  app.post('/api/chat/global/condense', async (req, res) => {
    const condensed = await condenseSession('global');
    if (condensed === null) return res.status(400).json({ error: 'Nothing to condense' });
    res.json({ ok: true, condensed });
  });

  // Per-project chat
  app.post('/api/chat/:projectId', async (req, res) => {
    const project = db.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      for await (const event of chat(project, message)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    }
    res.end();
  });

  app.post('/api/chat/:projectId/clear', (req, res) => {
    clearSession(req.params.projectId);
    res.json({ ok: true });
  });

  app.post('/api/chat/:projectId/condense', async (req, res) => {
    const condensed = await condenseSession(req.params.projectId);
    if (condensed === null) {
      return res.status(400).json({ error: 'Nothing to condense' });
    }
    res.json({ ok: true, condensed });
  });

  // Actions
  app.post('/api/open-finder', (req, res) => {
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'No path' });
    const { execFile } = require('child_process');
    execFile('open', [dirPath], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  });

  // Config (read-only — all config lives in .env)
  app.get('/api/config', (_req, res) => {
    res.json({ ...config.load(), model: MODEL });
  });

  return app;
}

function formatProject(p) {
  return {
    ...p,
    languages: tryParse(p.languages, []),
    integrations: tryParse(p.integrations, []),
    stale_deps: tryParse(p.stale_deps, []),
  };
}

function tryParse(val, fallback) {
  try { return JSON.parse(val); } catch { return fallback; }
}

module.exports = { createApp };
