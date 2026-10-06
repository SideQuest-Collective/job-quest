// app/lib/resume/grade.js
const fs = require('fs');
const path = require('path');
const { formatRange } = require('./master');
const { REFS_DIR, matchesAny, countMatches } = require('./lexicon');

let pdfjs = null;
function loadPdfjs() {
  if (!pdfjs) pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  return pdfjs;
}

function buildLines(items, page) {
  const glyphs = (items || [])
    .filter((it) => it && typeof it.str === 'string' && it.str.length && Array.isArray(it.transform))
    .map((it) => ({
      str: it.str.normalize('NFKC'),
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      size: Math.hypot(it.transform[2], it.transform[3]) || Math.hypot(it.transform[0], it.transform[1]) || 10,
    }));
  glyphs.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows = [];
  for (const g of glyphs) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - g.y) <= 2) last.items.push(g);
    else rows.push({ y: g.y, items: [g] });
  }
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const it of r.items) {
      if (end !== null && it.x - end > it.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      text += it.str;
      end = it.x + it.w;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), x: Math.round(r.items[0].x * 10) / 10, y: Math.round(r.y * 10) / 10, page };
  }).filter((l) => l.text);
}

async function extractPdf(pdfPath) {
  const lib = loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  // Do not supply standardFontDataUrl: substitute fonts hide missing embedded files.
  const doc = await lib.getDocument({
    data, disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0,
  }).promise;
  try {
    const lines = [];
    let fontsEmbedded = true;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      lines.push(...buildLines(content.items, p));
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== lib.OPS.setFont) continue;
        const fontId = ops.argsArray[i][0];
        const font = page.commonObjs.has(fontId) ? page.commonObjs.get(fontId) : null;
        if (font && font.missingFile) fontsEmbedded = false;
      }
      page.cleanup();
    }
    return { text: lines.map((l) => l.text).join('\n'), lines, pages: doc.numPages, fontsEmbedded };
  } finally {
    await doc.destroy();
  }
}

const round1 = (x) => Math.round(x * 10) / 10;

function normalizeForMatch(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/- /g, '-').trim();
}

function scoreKeywords(normText, keywords) {
  const req = (keywords && keywords.required) || [];
  const pref = (keywords && keywords.preferred) || [];
  const variants = (k) => [k.term, ...(k.alts || [])];
  const hit = (k) => matchesAny(normText, variants(k));
  const requiredHit = req.filter(hit).map((k) => k.term);
  const preferredHit = pref.filter(hit).map((k) => k.term);
  const stuffed = [...req, ...pref].filter((k) => countMatches(normText, variants(k)) > 3).map((k) => k.term);
  const reqRatio = req.length ? requiredHit.length / req.length : 1;
  const prefRatio = pref.length ? preferredHit.length / pref.length : 1;
  const K = Math.max(0, 30 * (0.8 * reqRatio + 0.2 * prefRatio) - 2 * stuffed.length);
  return {
    K: round1(K),
    keywords: {
      requiredHit,
      requiredMiss: req.map((k) => k.term).filter((t) => !requiredHit.includes(t)),
      preferredHit,
      preferredMiss: pref.map((k) => k.term).filter((t) => !preferredHit.includes(t)),
      stuffed,
    },
  };
}

const HEADINGS = ['summary', 'experience', 'projects', 'skills', 'education', 'certifications'];
const isHeading = (l) => HEADINGS.includes(String(l.text).trim().toLowerCase());
const headingIndex = (lines, name) => lines.findIndex((l) => String(l.text).trim().toLowerCase() === name);
const countWords = (text) => (String(text || '').match(/[A-Za-z0-9_]+/g) || []).length;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const ALLOWED_EXTRA = '–’•“”|';
const allowedChar = (c) => c === '\n' || (c >= ' ' && c <= '~') || ALLOWED_EXTRA.includes(c);
const MONTH_BEFORE = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) $/;

function checker(cat) {
  const checks = [];
  return { checks, add: (id, pass, detail = '') => checks.push({ cat, id, pass: !!pass, detail }) };
}

function checkParseability(ex, { master } = {}) {
  const { checks, add } = checker('P');
  add('one-page', ex.pages === 1, `${ex.pages} page(s)`);
  const words = countWords(ex.text);
  add('min-words', words >= 300, `${words} words`);
  const idx = Object.fromEntries(['summary', 'experience', 'projects', 'skills', 'education'].map((h) => [h, headingIndex(ex.lines, h)]));
  const order = ['summary', 'experience', ...(idx.projects >= 0 ? ['projects'] : []), 'skills', 'education'];
  const inOrder = order.every((h, i) => idx[h] >= 0 && (i === 0 || idx[h] > idx[order[i - 1]]));
  add('heading-order', inOrder, order.map((h) => `${h}@${idx[h]}`).join(' '));
  add('fonts-embedded', ex.fontsEmbedded === true, ex.fontsEmbedded ? '' : 'a font is not embedded');
  const odd = [...new Set([...String(ex.text)].filter((c) => !allowedChar(c)))].sort();
  add('ascii-only', odd.length === 0, odd.join(''));
  const flat = String(ex.text).replace(/\s+/g, ' ');
  const c = (master && master.contact) || {};
  const missing = [];
  if (!EMAIL_RE.test(flat)) missing.push('email');
  if (!PHONE_RE.test(flat)) missing.push('phone');
  if (!/linkedin\.com\/in\//i.test(flat)) missing.push('linkedin');
  const loc = String(c.location || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!loc || !flat.toLowerCase().includes(loc)) missing.push('location');
  add('contact', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : '');
  return { P: round1(checks.filter((x) => x.pass).length * 5), checks };
}

function checkStructure(ex, { keywords } = {}) {
  const { checks, add } = checker('S');
  for (const h of ['summary', 'experience', 'skills', 'education']) add(`heading-${h}`, headingIndex(ex.lines, h) >= 0);
  const title = String((keywords && keywords.title) || '').trim();
  const words = title.split(/\s+/).filter(Boolean);
  const lastTwo = words.slice(-2).join(' ').toLowerCase();
  const flat = String(ex.text).replace(/\s+/g, ' ').toLowerCase();
  add('target-title', !!title && (flat.includes(title.toLowerCase()) || (!!lastTwo && flat.includes(lastTwo))), title);
  return { S: round1(checks.filter((x) => x.pass).length * 3), checks };
}

function startsWithWord(line, s) {
  if (!s) return false;
  const a = String(line).toLowerCase();
  const b = String(s).toLowerCase();
  return a.startsWith(b) && !/[a-z0-9]/i.test(String(line).charAt(b.length));
}

const normDates = (s) => String(s).replace(/[–—]/g, '-').replace(/\s*-+\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function checkHistory(ex, { master } = {}) {
  const { checks, add } = checker('H');
  const lines = ex.lines.map((l) => String(l.text));
  const from = Math.max(0, headingIndex(ex.lines, 'summary'));
  const bad = [];
  for (let i = from; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/\b(?:19|20)\d{2}\b/g)) {
      if (!MONTH_BEFORE.test(lines[i].slice(Math.max(0, m.index - 4), m.index))) { bad.push(lines[i]); break; }
    }
  }
  add('date-format', bad.length === 0, bad.slice(0, 3).join(' | '));

  const exp = (master && master.experience) || [];
  const expIdx = Math.max(0, headingIndex(ex.lines, 'experience'));
  const posOf = (s, start) => { for (let i = start; i < lines.length; i++) if (startsWithWord(lines[i], s)) return i; return -1; };
  const ordered = (arr) => arr.filter((a) => a.pos >= 0).sort((a, b) => a.pos - b.pos).every((a, i, s) => i === 0 || s[i - 1].start >= a.start);
  const emps = exp.map((e) => {
    const pos = posOf(e.employer, expIdx);
    return { start: e.start, pos, roles: (e.roles || []).map((r) => ({ start: r.start, pos: posOf(r.title, pos >= 0 ? pos : expIdx) })) };
  });
  const chrono = exp.length > 0 && ordered(emps) && emps.every((e) => ordered(e.roles));
  add('reverse-chronological', chrono, chrono ? '' : 'roles are not newest first (or no master experience)');

  const missing = [];
  for (const e of exp) {
    const er = normDates(formatRange(e.start, e.end, ' - '));
    if (!lines.some((l) => startsWithWord(l, e.employer) && normDates(l).includes(er))) missing.push(e.employer);
    for (const r of e.roles || []) {
      const rr = normDates(formatRange(r.start, r.end, ' - '));
      if (!lines.some((l) => startsWithWord(l, r.title) && normDates(l).includes(rr))) missing.push(r.title);
    }
  }
  const matches = exp.length > 0 && missing.length === 0;
  add('history-matches-master', matches, missing.length ? `not found as in master: ${missing.join(', ')}` : (exp.length ? '' : 'no master experience'));
  return { H: round1(checks.filter((x) => x.pass).length * 5), checks };
}

function loadTellWords(file = path.join(REFS_DIR, 'ai-tells.txt')) {
  return fs.readFileSync(file, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function bulletsOf(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const text = String(l.text);
    if (text.startsWith('•')) {
      if (cur) out.push(cur.text);
      cur = { x: l.x, text: text.replace(/^•\s*/, '') };
      continue;
    }
    if (cur && l.x > cur.x + 1 && !isHeading(l)) { cur.text += ` ${text}`; continue; }
    if (cur) { out.push(cur.text); cur = null; }
  }
  if (cur) out.push(cur.text);
  return out;
}

function summaryOf(lines) {
  const i = headingIndex(lines, 'summary');
  if (i < 0) return '';
  const out = [];
  for (let k = i + 1; k < lines.length && !isHeading(lines[k]); k++) out.push(String(lines[k].text));
  return out.join(' ');
}

function countSub(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

function computeTells(ex, tellWords) {
  const text = String(ex.text);
  const low = text.toLowerCase().replace(/\s+/g, ' ').replace(/- /g, '-');
  const tells = [];
  for (const w of tellWords) {
    const n = countSub(low, w);
    if (n) tells.push(`'${w}' x${n}`);
  }
  if (text.includes('—')) tells.push('em dash');
  const ete = countSub(low, 'end-to-end');
  if (ete > 1) tells.push(`'end-to-end' x${ete}`);
  const colonBullets = bulletsOf(ex.lines).filter((b) => b.includes(':')).length;
  if (colonBullets) tells.push(`${colonBullets} bullets use colon setups`);
  const semi = countSub(text, ';');
  if (semi) tells.push(`${semi} semicolons`);
  const summary = summaryOf(ex.lines);
  if (summary) {
    const tri = (summary.match(/\w[^,.:]*, [^,.:]+,? and [^,.:]+/g) || []).length;
    if (tri > 1) tells.push(`${tri} triad lists in summary`);
    if (summary.includes(':')) tells.push('colon in summary');
    const fromTo = (summary.match(/\bfrom [^,.]+ to /g) || []).length;
    if (fromTo) tells.push(`'from X to Y' x${fromTo} in summary`);
  }
  return tells;
}

function checkContent(ex, tells) {
  const { checks, add } = checker('C');
  const words = countWords(ex.text);
  const bullets = bulletsOf(ex.lines);
  const withNumber = bullets.filter((b) => /\d/.test(b)).length;
  const ratio = bullets.length ? withNumber / bullets.length : 0;
  add('word-range', words >= 400 && words <= 850, `${words} words`);
  add('numeric-bullets', ratio >= 0.7, `${withNumber}/${bullets.length} bullets contain a number`);
  let C = 10;
  if (!checks[0].pass) C -= 2;
  if (!checks[1].pass) C -= 2;
  C -= tells.length;
  return { C: round1(Math.max(0, C)), checks, words };
}

function scoreExtracted(ex, { keywords, master, tellWords = loadTellWords() } = {}) {
  const kw = keywords || { title: '', required: [], preferred: [] };
  const k = scoreKeywords(normalizeForMatch(ex.text), kw);
  const p = checkParseability(ex, { master });
  const s = checkStructure(ex, { keywords: kw });
  const h = checkHistory(ex, { master });
  const tells = computeTells(ex, tellWords);
  const c = checkContent(ex, tells);
  const categories = { K: k.K, P: p.P, S: s.S, H: h.H, C: c.C };
  return {
    total: Math.round(categories.K + categories.P + categories.S + categories.H + categories.C),
    categories,
    keywords: k.keywords,
    checks: [...p.checks, ...s.checks, ...h.checks, ...c.checks],
    tells,
    words: c.words,
    pages: ex.pages,
  };
}

async function gradePdf(pdfPath, opts) {
  return scoreExtracted(await extractPdf(pdfPath), opts);
}

module.exports = {
  buildLines, extractPdf, round1, normalizeForMatch, scoreKeywords,
  headingIndex, countWords, checkParseability, checkStructure, checkHistory,
  loadTellWords, bulletsOf, summaryOf, computeTells, checkContent, scoreExtracted, gradePdf,
};
