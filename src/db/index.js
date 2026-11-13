const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../sauron.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      group_name TEXT,
      root_label TEXT,
      type TEXT,
      languages TEXT,
      last_commit_date INTEGER,
      last_commit_message TEXT,
      last_commit_author TEXT,
      commit_count_30d INTEGER DEFAULT 0,
      has_uncommitted INTEGER DEFAULT 0,
      has_readme INTEGER DEFAULT 0,
      has_claude_md INTEGER DEFAULT 0,
      branch TEXT,
      integrations TEXT,
      summary TEXT,
      summary_generated_at INTEGER,
      summary_commit_hash TEXT,
      ignored INTEGER DEFAULT 0,
      user_label TEXT,
      first_seen_at INTEGER NOT NULL,
      last_scanned_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      projects_found INTEGER DEFAULT 0,
      projects_updated INTEGER DEFAULT 0,
      summaries_generated INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0
    );
  `);

  // Incremental migrations — safely add columns that may not exist yet
  const addColumn = (table, col, type) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
  };
  addColumn('projects', 'has_readme', 'INTEGER DEFAULT 0');
  addColumn('projects', 'has_claude_md', 'INTEGER DEFAULT 0');
  addColumn('projects', 'has_git', 'INTEGER DEFAULT 0');
  addColumn('projects', 'stale_deps', 'TEXT');
  addColumn('projects', 'deps_checked_at', 'INTEGER');
  addColumn('projects', 'deps_commit_hash', 'TEXT');
  addColumn('projects', 'status', 'TEXT');
  addColumn('projects', 'commit_hash', 'TEXT');
  addColumn('projects', 'deep_scan_ignored', 'INTEGER DEFAULT 0');
  addColumn('projects', 'link_facts', 'TEXT');
  addColumn('projects', 'links_commit_hash', 'TEXT');
  addColumn('projects', 'links_checked_at', 'INTEGER');
  addColumn('scan_runs', 'scope', 'TEXT');
  addColumn('scan_runs', 'links_generated', 'INTEGER DEFAULT 0');
  addColumn('scan_runs', 'links_cost_usd', 'REAL DEFAULT 0');
  addColumn('scan_runs', 'links_failed', 'INTEGER DEFAULT 0');

  // One row per (scanned project, other project, identifier). Written from the
  // scanned project's side; read from either side (see links/linksFor).
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_links (
      project_id TEXT NOT NULL,
      other_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      kind TEXT,
      identifier TEXT NOT NULL,
      evidence TEXT,
      other_evidence TEXT,
      other_commit TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_links_project ON project_links(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_links_other ON project_links(other_id);
  `);
  addColumn('scan_runs', 'summaries_generated', 'INTEGER DEFAULT 0');
  addColumn('scan_runs', 'input_tokens', 'INTEGER DEFAULT 0');
  addColumn('scan_runs', 'output_tokens', 'INTEGER DEFAULT 0');
  addColumn('scan_runs', 'estimated_cost_usd', 'REAL DEFAULT 0');
}

function upsertProject(p) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO projects (
      id, name, path, group_name, root_label, type, languages,
      last_commit_date, last_commit_message, last_commit_author,
      commit_count_30d, has_uncommitted, has_readme, has_claude_md, has_git,
      branch, integrations, status, commit_hash, first_seen_at, last_scanned_at
    ) VALUES (
      @id, @name, @path, @group_name, @root_label, @type, @languages,
      @last_commit_date, @last_commit_message, @last_commit_author,
      @commit_count_30d, @has_uncommitted, @has_readme, @has_claude_md, @has_git,
      @branch, @integrations, @status, @commit_hash, @first_seen_at, @last_scanned_at
    )
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      group_name = excluded.group_name,
      root_label = excluded.root_label,
      type = excluded.type,
      languages = excluded.languages,
      last_commit_date = excluded.last_commit_date,
      last_commit_message = excluded.last_commit_message,
      last_commit_author = excluded.last_commit_author,
      commit_count_30d = excluded.commit_count_30d,
      has_uncommitted = excluded.has_uncommitted,
      has_readme = excluded.has_readme,
      has_claude_md = excluded.has_claude_md,
      has_git = excluded.has_git,
      branch = excluded.branch,
      integrations = excluded.integrations,
      status = excluded.status,
      commit_hash = excluded.commit_hash,
      last_scanned_at = excluded.last_scanned_at
  `);
  stmt.run(p);
}

function updateSummary(projectId, summary, commitHash) {
  getDb().prepare(`
    UPDATE projects SET summary = ?, summary_generated_at = ?, summary_commit_hash = ?
    WHERE id = ?
  `).run(summary, Date.now(), commitHash, projectId);
}

function getProjects({ includeIgnored = false } = {}) {
  const db = getDb();
  const where = includeIgnored ? '' : 'WHERE ignored = 0';
  return db.prepare(`SELECT * FROM projects ${where} ORDER BY last_commit_date DESC NULLS LAST`).all();
}

function getProject(id) {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function setIgnored(id, ignored) {
  getDb().prepare('UPDATE projects SET ignored = ? WHERE id = ?').run(ignored ? 1 : 0, id);
}

function setDeepScanIgnored(id, ignored) {
  getDb().prepare('UPDATE projects SET deep_scan_ignored = ? WHERE id = ?').run(ignored ? 1 : 0, id);
}

function setUserLabel(id, label) {
  getDb().prepare('UPDATE projects SET user_label = ? WHERE id = ?').run(label, id);
}

// scope: 'fleet' (full crawl of SCAN_ROOTS) or 'scoped' (an explicit project
// selection). Rows written before this column existed have scope NULL, which is
// deliberately not treated as 'fleet' — the freshness hints below would rather
// say "no record" than assert a scope that was never stored.
function startScanRun(type, scope = 'fleet') {
  const result = getDb().prepare(
    'INSERT INTO scan_runs (type, scope, started_at) VALUES (?, ?, ?)'
  ).run(type, scope, Date.now());
  return result.lastInsertRowid;
}

// estimatedCost is the run's total; linksCost is the part of it spent on link
// finding, kept separately so the per-summary average isn't inflated by it.
function finishScanRun(runId, found, updated, tokenUsage = {}) {
  const { inputTokens = 0, outputTokens = 0, estimatedCost = 0, summariesGenerated = 0,
    linksGenerated = 0, linksCost = 0, linksFailed = 0 } = tokenUsage;
  getDb().prepare(
    `UPDATE scan_runs SET finished_at = ?, projects_found = ?, projects_updated = ?,
     summaries_generated = ?, input_tokens = ?, output_tokens = ?, estimated_cost_usd = ?,
     links_generated = ?, links_cost_usd = ?, links_failed = ?
     WHERE id = ?`
  ).run(Date.now(), found, updated, summariesGenerated, inputTokens, outputTokens, estimatedCost,
    linksGenerated, linksCost, linksFailed, runId);
}

function saveLinks(projectId, facts, commitHash, edges) {
  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO project_links (project_id, other_id, direction, kind, identifier, evidence, other_evidence, other_commit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare('DELETE FROM project_links WHERE project_id = ?').run(projectId);
    for (const e of edges) {
      insert.run(projectId, e.other_id, e.direction, e.kind, e.identifier, e.evidence,
        JSON.stringify(e.other_evidence), e.other_commit, now);
    }
    db.prepare('UPDATE projects SET link_facts = ?, links_commit_hash = ?, links_checked_at = ? WHERE id = ?')
      .run(JSON.stringify(facts), commitHash, now, projectId);
  })();
}

function getAllLinks() {
  return getDb().prepare('SELECT * FROM project_links').all();
}

function getLinksTouching(projectId) {
  return getDb().prepare('SELECT * FROM project_links WHERE project_id = ? OR other_id = ?').all(projectId, projectId);
}

function getAverageLinkCost() {
  const row = getDb().prepare(
    'SELECT SUM(links_cost_usd) AS cost, SUM(links_generated) AS n FROM scan_runs WHERE links_generated > 0'
  ).get();
  return row && row.n ? row.cost / row.n : null;
}

function updateDeps(projectId, staleDeps, commitHash) {
  getDb().prepare(
    'UPDATE projects SET stale_deps = ?, deps_checked_at = ?, deps_commit_hash = ? WHERE id = ?'
  ).run(JSON.stringify(staleDeps), Date.now(), commitHash, projectId);
}

function getRecentScanRun() {
  return getDb().prepare('SELECT * FROM scan_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1').get();
}

function getLastFleetQuickScan() {
  return getDb().prepare(
    `SELECT * FROM scan_runs
     WHERE type = 'quick' AND scope = 'fleet' AND finished_at IS NOT NULL
     ORDER BY finished_at DESC LIMIT 1`
  ).get();
}

function getAverageQuickScanDuration() {
  const row = getDb().prepare(
    `SELECT AVG(finished_at - started_at) AS avg FROM scan_runs
     WHERE type = 'quick' AND scope = 'fleet' AND finished_at IS NOT NULL`
  ).get();
  return row && row.avg != null ? Math.round(row.avg) : null;
}

function countProjects({ includeIgnored = false } = {}) {
  const where = includeIgnored ? '' : 'WHERE ignored = 0';
  return getDb().prepare(`SELECT COUNT(*) AS n FROM projects ${where}`).get().n;
}

function countIgnoredProjects() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM projects WHERE ignored = 1').get().n;
}

function getAverageSummaryCost() {
  const row = getDb().prepare(
    `SELECT AVG((estimated_cost_usd - COALESCE(links_cost_usd, 0)) * 1.0 / summaries_generated) AS avg
     FROM scan_runs WHERE summaries_generated > 0`
  ).get();
  return row && row.avg != null ? row.avg : null;
}

module.exports = {
  getDb, upsertProject, updateSummary, updateDeps, getProjects, getProject,
  setIgnored, setDeepScanIgnored, setUserLabel, startScanRun, finishScanRun,
  getRecentScanRun, getAverageSummaryCost, getLastFleetQuickScan,
  getAverageQuickScanDuration, countProjects, countIgnoredProjects,
  saveLinks, getAllLinks, getLinksTouching, getAverageLinkCost
};
