// app/lib/jobs/settings.js
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  workbooks: { autoBuild: true, autoDailyCap: 3 },
});

// Resume tailoring is on-demand only. Older settings files may still carry
// resume.autoTailor / resume.autoDailyCap; they are dropped on read so they
// cannot turn automatic tailoring back on or reappear in the API.
const RETIRED_KEYS = ['resume'];

function dropRetired(settings) {
  for (const k of RETIRED_KEYS) delete settings[k];
  return settings;
}

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
    return dropRetired(merge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(file(dataDir), 'utf-8'))));
  } catch {
    return clone(DEFAULT_SETTINGS);
  }
}

function writeSettings(dataDir, patch) {
  const next = dropRetired(merge(readSettings(dataDir), patch));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { DEFAULT_SETTINGS, readSettings, writeSettings };
