const os = require('os');
const path = require('path');

function expandHome(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseScanRoots() {
  const raw = process.env.SCAN_ROOTS;
  if (!raw) return [];
  return raw.split(',').map(entry => {
    const [p, label] = entry.split(':');
    return { path: p.trim(), label: (label || p).trim() };
  });
}

function parseIgnore() {
  const raw = process.env.IGNORE_PATHS;
  if (!raw) return [];
  return raw.split(',').map(p => expandHome(p.trim())).filter(Boolean);
}

function load() {
  return {
    scanRoots: parseScanRoots(),
    ignore: parseIgnore(),
    activeCutoffDays: parseInt(process.env.ACTIVE_CUTOFF_DAYS || '30'),
    staleCutoffDays: parseInt(process.env.STALE_CUTOFF_DAYS || '180'),
    maxSummariesPerScan: parseInt(process.env.MAX_SUMMARIES_PER_SCAN || '50'),
  };
}

module.exports = { load, expandHome };
