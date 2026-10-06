// app/lib/resume/agents.js
const fs = require('fs');
const path = require('path');
const { REFS_DIR, matchesAny } = require('./lexicon');

function renderPrompt(name, vars) {
  const tpl = fs.readFileSync(path.join(REFS_DIR, `${name}.md`), 'utf-8');
  for (const m of tpl.matchAll(/\{\{(\w+)\}\}/g)) {
    if (vars[m[1]] === undefined || vars[m[1]] === null) throw new Error(`missing value for {{${m[1]}}} in ${name}.md`);
  }
  return tpl.replace(/\{\{(\w+)\}\}/g, (all, key) => {
    const value = String(vars[key]);
    // Scraped JD text must not close the prompt's data boundary.
    return key === 'jd' ? value.replace(/<\/jd>/gi, '&lt;/jd&gt;') : value;
  });
}

function extractJson(stdout) {
  const s = String(stdout || '');
  const fences = [...s.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try { return { ok: true, value: JSON.parse(fences[i][1]) }; } catch { /* try an earlier block */ }
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last <= first) return { ok: false, error: 'no JSON object found in agent output' };
  try { return { ok: true, value: JSON.parse(s.slice(first, last + 1)) }; } catch (err) { return { ok: false, error: `invalid JSON: ${err.message}` }; }
}

const ALT_STOP_WORDS = new Set('and or the of to in for with on at by a an is as be'.split(' '));

function verifyKeywords(raw, jdText) {
  const jd = String(jdText || '').replace(/\s+/g, ' ');
  const seen = new Set();
  const dropped = [];
  const clean = (list) => (Array.isArray(list) ? list : [])
    .map((k) => (typeof k === 'string' ? { term: k, alts: [] } : k))
    .filter((k) => k && typeof k.term === 'string' && k.term.trim())
    .map((k) => ({
      term: k.term.trim(),
      alts: (Array.isArray(k.alts) ? k.alts : [])
        .filter((a) => typeof a === 'string' && a.trim().length >= 3 && !ALT_STOP_WORDS.has(a.trim().toLowerCase()) && !a.includes('*'))
        .map((a) => a.trim())
        .slice(0, 4),
    }))
    .filter((k) => {
      if (k.term.includes('*') || !matchesAny(jd, [k.term, ...k.alts])) { dropped.push(k.term); return false; }
      const key = k.term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const required = clean(raw && raw.required);
  const preferred = clean(raw && raw.preferred);
  const title = raw && typeof raw.title === 'string' ? raw.title.trim() : '';
  return { title, required, preferred, dropped };
}

function keywordCountsOk(k) {
  return k.required.length >= 8 && k.required.length <= 20 && k.preferred.length <= 15;
}

module.exports = { renderPrompt, extractJson, verifyKeywords, keywordCountsOk };
