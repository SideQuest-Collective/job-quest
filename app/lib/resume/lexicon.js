// app/lib/resume/lexicon.js
const fs = require('fs');
const path = require('path');

const REFS_DIR = path.resolve(__dirname, '..', '..', '..', 'skill', 'references', 'resume');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termRegex(term, { caseSensitive = false, flags = '' } = {}) {
  let t = String(term).trim();
  let prefix = false;
  if (t.endsWith('*')) { prefix = true; t = t.slice(0, -1); }
  const body = escapeRe(t).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${body}${prefix ? '' : '(?![A-Za-z0-9])'}`, `${caseSensitive ? '' : 'i'}${flags}`);
}

function matchesAny(text, variants) {
  const s = String(text || '');
  return variants.some((v) => v && termRegex(v).test(s));
}

function countMatches(text, variants) {
  const s = String(text || '');
  const starts = new Set();
  for (const v of variants) {
    if (!v) continue;
    const re = termRegex(v, { flags: 'g' });
    let m;
    while ((m = re.exec(s))) {
      starts.add(m.index);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return starts.size;
}

function isCaseInsensitiveEntry(term) {
  if (/[^A-Za-z ]/.test(term)) return true;
  return /[a-z][A-Z]/.test(term);
}

function loadGenericLexicon(file = path.join(REFS_DIR, 'tech-lexicon.txt')) {
  return fs.readFileSync(file, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function skillParts(item) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(item);
  if (!m) return [];
  return [m[1], ...m[2].split(',')].map((s) => s.trim()).filter(Boolean);
}

function buildLexicon(master, { generic = loadGenericLexicon() } = {}) {
  const entries = new Map();
  const add = (term, ci) => {
    const t = String(term || '').trim();
    if (t.length < 2) return;
    const key = t.toLowerCase();
    if (entries.has(key)) return;
    entries.set(key, { term: t, re: termRegex(t, { caseSensitive: !ci }) });
  };
  for (const g of (master && master.skills) || []) {
    for (const item of g.items || []) {
      add(item, true);
      for (const part of skillParts(item)) add(part, true);
    }
  }
  for (const p of (master && master.projects) || []) for (const t of p.tech || []) add(t, true);
  for (const t of generic) add(t, isCaseInsensitiveEntry(t));
  const list = [...entries.values()];
  return {
    terms: list.map((e) => e.term),
    has(term, text, { caseSensitive } = {}) {
      const entry = entries.get(String(term).trim().toLowerCase());
      return entry ? (caseSensitive === undefined ? entry.re : termRegex(entry.term, { caseSensitive })).test(String(text || '')) : false;
    },
    find(text) {
      const s = String(text || '');
      return list.filter((e) => e.re.test(s)).map((e) => e.term);
    },
  };
}

module.exports = { REFS_DIR, termRegex, matchesAny, countMatches, isCaseInsensitiveEntry, loadGenericLexicon, buildLexicon };
