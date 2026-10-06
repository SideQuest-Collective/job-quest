// app/tests/helpers/gradepy-port.js
// Port of a reference grade.py formula, applied to extractPdf() output.
const HEADINGS = new Set(['summary', 'experience', 'projects', 'skills', 'education', 'certifications']);

function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// pdftotext (non-layout) separates blocks with a blank line; reproduce that before each heading.
function rawText(ex) {
  return ex.lines.map((l, i) => (i > 0 && HEADINGS.has(l.text.trim().toLowerCase()) ? `\n${l.text}` : l.text)).join('\n');
}

function convertGradePyJd(jd) {
  return {
    title: jd.title,
    required: jd.kw.map((k) => { const [term, ...alts] = k.split('|'); return { term: `${term}*`, alts: alts.map((a) => `${a}*`) }; }),
    preferred: [],
  };
}

function gradePyScore(ex, jd, tellWords) {
  const raw = rawText(ex);
  const low = raw.toLowerCase().replace(/\s+/g, ' ').replace(/- /g, '-');
  const hit = jd.kw.filter((k) => new RegExp(k.toLowerCase()).test(low));
  const kw = hit.length / jd.kw.length;
  const fmt = [];
  if (ex.pages !== 1) fmt.push('pages');
  for (const [need, pat] of [['email', /@/], ['phone', /\d{3}-\d{3}-\d{4}/], ['linkedin', /linkedin\.com/]]) {
    if (!pat.test(low)) fmt.push(`missing ${need}`);
  }
  for (const h of ['summary', 'experience', 'skills', 'education']) {
    if (!new RegExp(`^\\s*${h}\\s*$`, 'm').test(raw.toLowerCase())) fmt.push(`heading not found: ${h}`);
  }
  if (!new RegExp(jd.title.toLowerCase()).test(low)) fmt.push('target title not in text');
  if (!ex.fontsEmbedded) fmt.push('non-embedded font');
  if ([...raw].some((c) => c.charCodeAt(0) > 127 && !'–’•“”|'.includes(c))) fmt.push('unusual chars');
  const words = (raw.match(/\w+/g) || []).length;
  if (words < 400 || words > 850) fmt.push(`word count ${words}`);
  const tells = [];
  for (const w of tellWords) if (low.split(w).length - 1) tells.push(w);
  if (raw.includes('\u2014')) tells.push('em dash');
  if (low.split('end-to-end').length - 1 > 1) tells.push('end-to-end');
  const bullets = raw.split('\n•').slice(1);
  if (bullets.filter((b) => b.split('\n\n')[0].includes(':')).length) tells.push('colon bullets');
  if (raw.includes(';')) tells.push('semicolons');
  const summ = /Summary\n([\s\S]*?)\nExperience/.exec(raw);
  if (summ) {
    const s = summ[1].replace(/\n/g, ' ');
    if ((s.match(/\w[^,.:]*, [^,.:]+,? and [^,.:]+/g) || []).length > 1) tells.push('triads');
    if (s.includes(':')) tells.push('colon in summary');
    if ((s.match(/\bfrom [^,.]+ to /g) || []).length) tells.push('from-to');
  }
  return roundHalfEven(60 * kw + 25 * Math.max(0, 1 - 0.2 * fmt.length) + 15 * Math.max(0, 1 - 0.2 * tells.length));
}

function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

const spearman = (a, b) => pearson(ranks(a), ranks(b));

module.exports = { roundHalfEven, convertGradePyJd, gradePyScore, spearman };
