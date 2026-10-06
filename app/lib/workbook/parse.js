// app/lib/workbook/parse.js
const fs = require('fs');
const path = require('path');

const HEADER_RE = /^@@(chapter|q)\s+(.*)$/;
const SECTION_RE = /^@@(choices|hint|rubric|tests|answer)\s*$/;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAttrs(s) {
  const out = {};
  String(s).replace(/(\w+)=("([^"]*)"|\S+)/g, (m, k, v, q) => {
    out[k] = q !== undefined ? q : v;
    return '';
  });
  return out;
}

function finish(item) {
  for (const [k, v] of Object.entries(item._s)) item[k] = v.join('\n').trim();
  delete item._s;
  if (item.kind === 'question') {
    item.type = item.attrs.type || 'open';
    const d = Number(item.attrs.diff);
    item.diff = d === 1 || d === 2 || d === 3 ? d : 2;
  }
  return item;
}

function parseFile(text, file) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const items = [];
  let cur = null;
  let sec = null;
  lines.forEach((ln, i) => {
    const h = ln.match(HEADER_RE);
    if (h) {
      if (cur) items.push(finish(cur));
      const attrs = parseAttrs(h[2]);
      cur = { ...attrs, kind: h[1] === 'q' ? 'question' : 'chapter', attrs, file, line: i + 1, sections: {}, _s: { body: [] } };
      sec = 'body';
      return;
    }
    const s = ln.match(SECTION_RE);
    if (s && cur) {
      sec = s[1];
      cur._s[sec] = [];
      cur.sections[sec] = i + 1;
      return;
    }
    if (cur) cur._s[sec].push(ln);
  });
  if (cur) items.push(finish(cur));
  return {
    items,
    chapters: items.filter((x) => x.kind === 'chapter'),
    questions: items.filter((x) => x.kind === 'question'),
  };
}

function parseTexts(files) {
  const items = [];
  for (const f of files) items.push(...parseFile(f.text, f.name).items);
  return {
    items,
    chapters: items.filter((x) => x.kind === 'chapter'),
    questions: items.filter((x) => x.kind === 'question'),
  };
}

function listContentFiles(contentDir) {
  if (!fs.existsSync(contentDir)) return { md: [], glossary: [] };
  const names = fs.readdirSync(contentDir).filter((n) => !n.startsWith('.')).sort();
  return {
    md: names.filter((n) => n.endsWith('.md')),
    glossary: names.filter((n) => /^glossary-.*\.txt$/.test(n)),
  };
}

function parseContentDir(contentDir) {
  const { md, glossary } = listContentFiles(contentDir);
  const read = (name) => ({ name, text: fs.readFileSync(path.join(contentDir, name), 'utf-8') });
  const files = md.map(read);
  const glossaryFiles = glossary.map(read);
  return { ...parseTexts(files), files, glossaryFiles };
}

function parseChoices(raw) {
  const out = [];
  String(raw || '').split('\n').forEach((ln) => {
    const m = ln.match(/^\s*-\s*\[( |x)\]\s*(.*)$/i);
    if (m) out.push({ text: m[2].trim(), correct: m[1].toLowerCase() === 'x' });
    else if (out.length && ln.trim()) out[out.length - 1].text += ` ${ln.trim()}`;
  });
  return out;
}

function parseTests(raw) {
  if (raw === undefined || raw === null) return { ok: false, error: 'missing @@tests' };
  const fence = String(raw).match(/```(?:json)?[^\n]*\n([\s\S]*?)```/);
  const body = (fence ? fence[1] : String(raw)).trim();
  let v;
  try { v = JSON.parse(body); } catch (e) { return { ok: false, error: `@@tests is not valid JSON: ${e.message}` }; }
  if (!v || typeof v !== 'object' || typeof v.entry !== 'string' || !v.entry) {
    return { ok: false, error: '@@tests needs a string "entry"' };
  }
  const hasCases = Array.isArray(v.cases);
  const hasCalls = Array.isArray(v.calls);
  if (hasCases === hasCalls) return { ok: false, error: '@@tests needs exactly one of "cases" or "calls"' };
  if (hasCases && (!v.cases.length || v.cases.some((c) => !c || !Array.isArray(c.args) || !('expect' in c)))) {
    return { ok: false, error: 'each case needs "args" (an array) and "expect"' };
  }
  if (hasCalls && (!v.calls.length || v.calls.some((c) => !Array.isArray(c) || c.length !== 3 || typeof c[0] !== 'string' || !Array.isArray(c[1])))) {
    return { ok: false, error: 'each call must be ["method", [args], expected]' };
  }
  return { ok: true, value: v };
}

function referenceSolution(answer, entry) {
  const blocks = [];
  const re = /```python[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(answer || '')))) blocks.push(m[1]);
  const defRe = new RegExp(`^(def|class)\\s+${escapeRe(entry)}\\b`, 'm');
  const cands = blocks.filter((b) => defRe.test(b));
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.length > a.length ? b : a));
}

module.exports = {
  escapeRe, parseAttrs, parseFile, parseTexts, listContentFiles, parseContentDir,
  parseChoices, parseTests, referenceSolution,
};
