const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config.json');

function parseScanRoots() {
  const raw = process.env.SCAN_ROOTS;
  if (!raw) return [];
  return raw.split(',').map(entry => {
    const [p, label] = entry.split(':');
    return { path: p.trim(), label: (label || p).trim() };
  });
}

function load() {
  const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Scan roots come from .env, everything else from config.json
  file.scanRoots = parseScanRoots();
  return file;
}

function save(config) {
  // Don't persist scanRoots back — they live in .env
  const { scanRoots, ...rest } = config;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(rest, null, 2));
}

module.exports = { load, save, CONFIG_PATH };
