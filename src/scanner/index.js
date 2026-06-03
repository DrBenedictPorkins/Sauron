const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml'];
const MAX_DEPTH = 4;

// Only truly generic directories that are never projects
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', '.tox',
  '.eggs', '.mypy_cache', 'target', '.gradle',
]);

function expandHome(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

function classifyDir(entries) {
  const names = entries.map(e => e.name);
  const hasGit = names.includes('.git');
  const hasProjectFile = PROJECT_MARKERS.some(m => names.includes(m));
  const hasXcodeproj = names.some(n => n.endsWith('.xcodeproj'));
  const hasClaudeMd = names.includes('CLAUDE.md');
  return hasGit || hasProjectFile || hasXcodeproj || hasClaudeMd;
}

function detectProjectType(entries, dirPath) {
  const names = entries.map(e => e.name);
  if (names.some(n => n.endsWith('.xcodeproj'))) return 'swift';
  if (names.includes('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.electron) return 'electron';
      if (deps['react-native']) return 'react-native';
      if (deps.next) return 'nextjs';
      if (deps.react) return 'react';
      return names.includes('tsconfig.json') ? 'typescript' : 'nodejs';
    } catch {
      return 'nodejs';
    }
  }
  if (names.includes('pyproject.toml') || names.includes('setup.py')) return 'python';

  // No markers at root — peek into subdirectories (monorepo detection)
  const subTypes = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const subPath = path.join(dirPath, entry.name);
    try {
      const subNames = fs.readdirSync(subPath);
      if (subNames.some(n => n.endsWith('.xcodeproj'))) subTypes.add('swift');
      if (subNames.includes('package.json')) subTypes.add('nodejs');
      if (subNames.includes('pyproject.toml') || subNames.includes('setup.py') || subNames.includes('requirements.txt')) subTypes.add('python');
      if (subNames.includes('Cargo.toml')) subTypes.add('rust');
    } catch {}
  }
  if (subTypes.size > 0) return 'monorepo';
  return 'unknown';
}

function scan(rootPath, rootLabel, ignoredPaths, depth = 0, groupName = null) {
  const projects = [];
  if (depth > MAX_DEPTH) return projects;

  const entries = readDir(rootPath);
  if (!entries) return projects;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(rootPath, entry.name);
    if (ignoredPaths.has(fullPath)) continue;

    const childEntries = readDir(fullPath);
    if (!childEntries) continue;

    if (classifyDir(childEntries)) {
      projects.push({
        path: fullPath,
        name: entry.name,
        group: groupName,
        rootLabel,
        type: detectProjectType(childEntries, fullPath),
      });
    } else {
      // Not a project — treat as group directory, recurse
      const subProjects = scan(fullPath, rootLabel, ignoredPaths, depth + 1, entry.name);
      projects.push(...subProjects);
    }
  }

  return projects;
}

function scanAll(cfg) {
  const ignored = new Set((cfg.ignore || []).map(expandHome));
  const all = [];

  for (const root of cfg.scanRoots) {
    const rootPath = expandHome(root.path);
    if (!fs.existsSync(rootPath)) continue;
    all.push(...scan(rootPath, root.label, ignored, 0, null));
  }

  return all;
}

function validateRoots(scanRoots) {
  const expanded = scanRoots.map(r => expandHome(r.path));
  const warnings = [];
  for (let i = 0; i < expanded.length; i++) {
    for (let j = i + 1; j < expanded.length; j++) {
      if (expanded[j].startsWith(expanded[i] + path.sep)) {
        warnings.push(`"${expanded[j]}" is a subdirectory of "${expanded[i]}" — overlapping scan roots`);
      }
    }
  }
  return warnings;
}

module.exports = { scanAll, validateRoots, expandHome };
