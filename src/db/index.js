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
      branch, integrations, first_seen_at, last_scanned_at
    ) VALUES (
      @id, @name, @path, @group_name, @root_label, @type, @languages,
      @last_commit_date, @last_commit_message, @last_commit_author,
      @commit_count_30d, @has_uncommitted, @has_readme, @has_claude_md, @has_git,
      @branch, @integrations, @first_seen_at, @last_scanned_at
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

function setUserLabel(id, label) {
  getDb().prepare('UPDATE projects SET user_label = ? WHERE id = ?').run(label, id);
}

function startScanRun(type) {
  const result = getDb().prepare(
    'INSERT INTO scan_runs (type, started_at) VALUES (?, ?)'
  ).run(type, Date.now());
  return result.lastInsertRowid;
}

function finishScanRun(runId, found, updated, tokenUsage = {}) {
  const { inputTokens = 0, outputTokens = 0, estimatedCost = 0, summariesGenerated = 0 } = tokenUsage;
  getDb().prepare(
    `UPDATE scan_runs SET finished_at = ?, projects_found = ?, projects_updated = ?,
     summaries_generated = ?, input_tokens = ?, output_tokens = ?, estimated_cost_usd = ?
     WHERE id = ?`
  ).run(Date.now(), found, updated, summariesGenerated, inputTokens, outputTokens, estimatedCost, runId);
}

function getRecentScanRun() {
  return getDb().prepare('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1').get();
}

module.exports = {
  getDb, upsertProject, updateSummary, getProjects, getProject,
  setIgnored, setUserLabel, startScanRun, finishScanRun, getRecentScanRun
};
