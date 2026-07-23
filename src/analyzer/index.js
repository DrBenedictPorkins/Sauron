const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');

const execAsync = promisify(execFile);

const INTEGRATION_PATTERNS = [
  { name: 'Slack', patterns: ['@slack/bolt', '@slack/web-api', 'slack-sdk', 'slackbot', 'slack_sdk'] },
  { name: 'Discord', patterns: ['discord.js', 'discord-api-types', 'discord.py', 'discordpy'] },
  { name: 'MCP', patterns: ['@modelcontextprotocol', 'mcp-server', 'mcp_server', 'modelcontextprotocol'] },
  { name: 'Electron', patterns: ['electron'] },
  { name: 'OpenAI', patterns: ['openai'] },
  { name: 'Anthropic', patterns: ['@anthropic-ai/sdk', 'anthropic'] },
  { name: 'LangChain', patterns: ['langchain'] },
  { name: 'React Native', patterns: ['react-native'] },
  { name: 'Next.js', patterns: ['next'] },
  { name: 'AWS', patterns: ['aws-sdk', 'boto3', '@aws-sdk'] },
  { name: 'Supabase', patterns: ['@supabase/supabase-js', 'supabase'] },
  { name: 'Stripe', patterns: ['stripe'] },
  { name: 'Pulumi', patterns: ['@pulumi/pulumi', 'pulumi'] },
];

const LANGUAGE_MAP = {
  swift: ['Swift'],
  python: ['Python'],
  electron: ['JavaScript'],
  'react-native': ['TypeScript'],
  typescript: ['TypeScript'],
  nextjs: ['TypeScript'],
  nodejs: ['JavaScript'],
  react: ['JavaScript'],
};

const EXT_TO_LANG = {
  '.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.jsx': 'JavaScript', '.swift': 'Swift', '.go': 'Go', '.rs': 'Rust',
  '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin', '.groovy': 'Groovy',
  '.c': 'C', '.cpp': 'C++', '.h': 'C/C++', '.cs': 'C#',
  '.sh': 'Shell', '.zsh': 'Shell', '.bash': 'Shell',
  '.lua': 'Lua', '.php': 'PHP', '.r': 'R', '.scala': 'Scala',
  '.dart': 'Dart', '.zig': 'Zig', '.nim': 'Nim', '.ex': 'Elixir',
};

function detectLanguagesFromFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath);
    const counts = {};
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      const lang = EXT_TO_LANG[ext];
      if (lang) counts[lang] = (counts[lang] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(e => e[0]);
    return sorted.length > 0 ? sorted.slice(0, 3) : ['Unknown'];
  } catch {
    return ['Unknown'];
  }
}

async function exec(args, cwd) {
  try {
    const { stdout } = await execAsync('git', args, { cwd, timeout: 10000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitInfo(projectPath) {
  if (!fs.existsSync(path.join(projectPath, '.git'))) return null;

  const [logLine, branch, countStr, statusOutput, recentLog] = await Promise.all([
    exec(['log', '-1', '--format=%H%n%ct%n%s%n%an'], projectPath),
    exec(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath),
    exec(['rev-list', '--count', `--after=${Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000)}`, 'HEAD'], projectPath),
    exec(['status', '--porcelain'], projectPath),
    exec(['log', '-10', '--format=%s'], projectPath),
  ]);

  let commitHash = null, lastCommitDate = null, lastCommitMessage = null, lastCommitAuthor = null;
  if (logLine) {
    const [hash, ts, subject, author] = logLine.split('\n');
    commitHash = hash || null;
    lastCommitDate = ts ? parseInt(ts) * 1000 : null;
    lastCommitMessage = subject || null;
    lastCommitAuthor = author || null;
  }

  return {
    commitHash, lastCommitDate, lastCommitMessage, lastCommitAuthor,
    branch: branch || null,
    commitCount30d: countStr ? parseInt(countStr) : 0,
    hasUncommitted: statusOutput !== null && statusOutput.length > 0,
    recentCommits: recentLog ? recentLog.split('\n').filter(Boolean) : [],
  };
}

function detectIntegrations(projectPath) {
  const found = new Set();

  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const { name, patterns } of INTEGRATION_PATTERNS) {
        if (patterns.some(p => allDeps[p] !== undefined)) found.add(name);
      }
    } catch {}
  }

  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf8').toLowerCase();
      for (const { name, patterns } of INTEGRATION_PATTERNS) {
        if (patterns.some(p => content.includes(p.toLowerCase()))) found.add(name);
      }
    } catch {}
  }

  if (fs.existsSync(path.join(projectPath, 'Dockerfile')) ||
      fs.existsSync(path.join(projectPath, 'docker-compose.yml')) ||
      fs.existsSync(path.join(projectPath, 'docker-compose.yaml'))) {
    found.add('Docker');
  }

  return [...found];
}

// Deterministic activity status from git metrics — no AI needed.
// Maps to the UI's status pills: Active, Stale (Quiet), Abandoned (Dormant).
function computeStatus(dbFields, cfg = {}) {
  const DAY = 86400000;
  const activeMs = (cfg.activeCutoffDays || 30) * DAY;
  const staleMs = (cfg.staleCutoffDays || 180) * DAY;
  // No git or no commit history — nothing to gauge activity from.
  if (!dbFields.has_git || !dbFields.last_commit_date) return 'Abandoned';
  const age = Date.now() - dbFields.last_commit_date;
  if (age <= activeMs || dbFields.commit_count_30d > 0) return 'Active';
  if (age <= staleMs) return 'Stale';
  return 'Abandoned';
}

function readTextFile(filePath, maxChars = 1200) {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, maxChars);
  } catch {
    return null;
  }
}

function getProjectContext(projectPath) {
  const readme = readTextFile(path.join(projectPath, 'README.md'))
    || readTextFile(path.join(projectPath, 'readme.md'))
    || readTextFile(path.join(projectPath, 'README'));
  const claudeMd = readTextFile(path.join(projectPath, 'CLAUDE.md'));
  return { readme, claudeMd };
}

function makeProjectId(projectPath) {
  return crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 12);
}

async function analyze(scannedProject, cfg = {}) {
  const { path: projectPath, name, group, rootLabel, type } = scannedProject;

  const hasGit = fs.existsSync(path.join(projectPath, '.git'));
  const git = await gitInfo(projectPath);
  const integrations = detectIntegrations(projectPath);
  const languages = LANGUAGE_MAP[type] || detectLanguagesFromFiles(projectPath);
  const context = getProjectContext(projectPath);

  const dbFields = {
    id: makeProjectId(projectPath),
    name,
    path: projectPath,
    group_name: group || null,
    root_label: rootLabel,
    type,
    languages: JSON.stringify(languages),
    last_commit_date: git?.lastCommitDate || null,
    last_commit_message: git?.lastCommitMessage || null,
    last_commit_author: git?.lastCommitAuthor || null,
    commit_count_30d: git?.commitCount30d || 0,
    has_uncommitted: git?.hasUncommitted ? 1 : 0,
    has_readme: context.readme ? 1 : 0,
    has_claude_md: context.claudeMd ? 1 : 0,
    has_git: hasGit ? 1 : 0,
    branch: git?.branch || null,
    integrations: JSON.stringify(integrations),
    commit_hash: git?.commitHash || null,
    first_seen_at: Date.now(),
    last_scanned_at: Date.now(),
  };
  dbFields.status = computeStatus(dbFields, cfg);

  const transient = {
    context,
    commitHash: git?.commitHash || null,
    recentCommits: git?.recentCommits || [],
  };

  return { dbFields, transient };
}

const NODE_PROJECT_TYPES = new Set(['nodejs', 'typescript', 'electron', 'react', 'nextjs', 'react-native']);

function checkDeps(projectPath, projectType) {
  const { spawnSync } = require('child_process');
  const results = [];

  // Node.js
  if (NODE_PROJECT_TYPES.has(projectType) && fs.existsSync(path.join(projectPath, 'package.json'))) {
    if (fs.existsSync(path.join(projectPath, 'node_modules'))) {
      const r = spawnSync('npm', ['outdated', '--json'], { cwd: projectPath, encoding: 'utf8', timeout: 30000 });
      try {
        const outdated = JSON.parse(r.stdout || '{}');
        for (const [name, info] of Object.entries(outdated)) {
          if (info.current && info.latest && info.current !== info.latest) {
            results.push({ name, current: info.current, latest: info.latest });
          }
        }
      } catch {}
    }
  }

  // Python
  if (projectType === 'python' && fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
    const r = spawnSync('pip', ['list', '--outdated', '--format=json'], { cwd: projectPath, encoding: 'utf8', timeout: 30000 });
    try {
      const outdated = JSON.parse(r.stdout || '[]');
      for (const pkg of outdated) {
        results.push({ name: pkg.name, current: pkg.version, latest: pkg.latest_version });
      }
    } catch {}
  }

  return results;
}

module.exports = { analyze, getProjectContext, makeProjectId, checkDeps, computeStatus };
