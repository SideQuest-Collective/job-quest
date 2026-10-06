// app/lib/jobs/settings.js
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  workbooks: { autoBuild: true, autoDailyCap: 3 },
  resume: { autoTailor: true, autoDailyCap: 5 },
});

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function merge(base, patch) {
  const out = clone(base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = merge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function file(dataDir) { return path.join(dataDir, 'settings.json'); }

function readSettings(dataDir) {
  try {
    return merge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(file(dataDir), 'utf-8')));
  } catch {
    return clone(DEFAULT_SETTINGS);
  }
}

function writeSettings(dataDir, patch) {
  const next = merge(readSettings(dataDir), patch);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { DEFAULT_SETTINGS, readSettings, writeSettings };
