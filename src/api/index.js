const express = require('express');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { runScan, isScanInProgress, getProgress, requestStop } = require('../scanner/orchestrator');
const { chat, clearSession, condenseSession } = require('../chat');

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

  // Scan
  app.post('/api/scan', (req, res) => {
    if (isScanInProgress()) {
      return res.status(409).json({ error: 'Scan already in progress' });
    }
    const { type = 'deep', projectIds } = req.body;
    const label = projectIds ? `targeted scan (${projectIds.length} projects)` : `${type} scan`;
    res.json({ ok: true, message: `${label} started` });
    runScan(config.load(), type, { projectIds }).catch(console.error);
  });

  app.get('/api/scan/status', (_req, res) => {
    res.json({
      inProgress: isScanInProgress(),
      progress: getProgress(),
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

  // Chat
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
    res.json(config.load());
  });

  return app;
}

function formatProject(p) {
  return {
    ...p,
    languages: tryParse(p.languages, []),
    integrations: tryParse(p.integrations, []),
  };
}

function tryParse(val, fallback) {
  try { return JSON.parse(val); } catch { return fallback; }
}

module.exports = { createApp };
