// app/lib/workbook/glossary.js
const fs = require('fs');

const STRIP = /^[`* ]+|[`* ]+$/g;

function cpLen(s) {
  return [...s].length;
}

function parseGlossaryText(text, file) {
  const entries = [];
  const errors = [];
  String(text).replace(/\r/g, '').split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const err = (message) => errors.push({ file, line: i + 1, rule: 'glossary-line', message });
    const idx = line.indexOf('::');
    if (idx === -1) { err('line has no "term :: definition" separator'); return; }
    const term = line.slice(0, idx).trim().replace(STRIP, '');
    const def = line.slice(idx + 2).trim();
    if (cpLen(term) < 2) { err(`term "${term}" is shorter than 2 characters`); return; }
    if (!def) { err(`term "${term}" has an empty definition`); return; }
    entries.push({ term, def, file, line: i + 1 });
  });
  return { entries, errors };
}

function mergeGlossaries(files, nolink = new Set()) {
  const map = new Map();
  for (const f of files) {
    for (const e of parseGlossaryText(f.text, f.name).entries) {
      const key = e.term.toLowerCase();
      const prev = map.get(key);
      if (!prev || cpLen(e.def) > cpLen(prev.d)) map.set(key, { t: e.term, d: e.def });
    }
  }
  return [...map.keys()].sort().map((key) => {
    const g = map.get(key);
    return nolink.has(g.t.toLowerCase()) ? { t: g.t, d: g.d, nl: 1 } : { t: g.t, d: g.d };
  });
}

function loadNolink(file) {
  const set = new Set();
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return set; }
  for (const line of text.split('\n')) {
    const w = line.trim().toLowerCase();
    if (w && !w.startsWith('#')) set.add(w);
  }
  return set;
}

module.exports = { parseGlossaryText, mergeGlossaries, loadNolink };
