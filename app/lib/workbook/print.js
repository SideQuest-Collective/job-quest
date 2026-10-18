// app/lib/workbook/print.js
// A printable, reading-first layout of a workbook, turned into a PDF by "Download offline".
// Chapters appear in workbook order; each is followed by its practice questions, then an answer key
// on a fresh page, so the reader can test themselves before looking. Diagrams are drawn as SVG.
const { renderDiagram } = require('./diagram');

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  const codes = [];
  let t = String(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function renderList(items) {
  const out = [];
  const stack = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    while (stack.length && stack[stack.length - 1].indent > it.indent) out.push(`</li></${stack.pop().tag}>`);
    if (!stack.length || stack[stack.length - 1].indent < it.indent) { out.push(`<${tag}><li>`); stack.push({ indent: it.indent, tag }); }
    else out.push('</li><li>');
    out.push(inline(it.text));
  }
  while (stack.length) out.push(`</li></${stack.pop().tag}>`);
  return out.join('');
}

// Renders the workbook's Markdown subset (see skill/references/workbook/format-spec.md).
// `shift` lowers heading levels so a question's headings sit under its chapter's.
function markdown(src, shift = 0) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const s = line.trim();
    if (s.startsWith('```')) {
      flush();
      const lang = s.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(lang === 'diagram' ? renderDiagram(buf.join('\n')) : `<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = s.match(/^(#{1,5})\s+(.*)$/);
    if (h) { flush(); const lvl = Math.min(h[1].length + shift, 6); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }
    if (/^-{3,}$/.test(s)) { flush(); out.push('<hr>'); i++; continue; }
    if (s.startsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      let start = 0;
      let t = '<table>';
      if (rows[1] && /^\|?\s*:?-{2,}/.test(rows[1].trim())) { t += `<thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`; start = 2; }
      t += `<tbody>${rows.slice(start).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      out.push(t);
      continue;
    }
    if (s.startsWith('>')) {
      flush();
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) buf.push(lines[i++].trim().replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (m) { items.push({ indent: m[1].length, ordered: m[2].endsWith('.'), text: m[3] }); i++; }
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) { items[items.length - 1].text += ` ${lines[i].trim()}`; i++; }
        else break;
      }
      out.push(renderList(items));
      continue;
    }
    if (!s) { flush(); i++; continue; }
    para.push(s);
    i++;
  }
  flush();
  return out.join('\n');
}

function choices(raw) {
  return String(raw || '').split('\n').map((l) => l.match(/^\s*-\s*\[( |x)\]\s*(.*)$/i)).filter(Boolean)
    .map((m) => ({ correct: m[1].toLowerCase() === 'x', text: m[2] }));
}

const KIND = { mcq: 'Multiple choice', open: 'Written or spoken', code: 'Code' };

const CSS = `
@page { size: Letter; margin: 0.7in 0.75in; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.5; color: #1b1b1b; }
h1, h2, h3, h4 { font-family: Helvetica, Arial, sans-serif; color: #1F4E79; page-break-after: avoid; }
h1 { font-size: 22pt; margin: 0 0 6pt; border-bottom: 2.5px solid #1F4E79; padding-bottom: 4pt; }
h2 { font-size: 15pt; margin: 18pt 0 6pt; border-bottom: 1px solid #c8d3e0; padding-bottom: 2pt; }
h3 { font-size: 12.5pt; margin: 13pt 0 4pt; }
h4, h5, h6 { font-size: 11.5pt; margin: 10pt 0 3pt; color: #1b1b1b; }
.cover { padding-top: 1.6in; } .cover h1 { font-size: 30pt; border: none; }
.cover .sub { font-size: 13pt; color: #444; }
.toc li { margin: 2pt 0; } .toc a { color: #1b1b1b; text-decoration: none; }
.chapter { page-break-before: always; }
.meta { color: #666; font-style: italic; margin-bottom: 10pt; }
pre { background: #EEF3F9; padding: 7pt 9pt; border-radius: 4px; font-size: 8.8pt; line-height: 1.35; white-space: pre-wrap; page-break-inside: avoid; }
code { font-family: Menlo, Consolas, monospace; font-size: 0.86em; background: #EEF3F9; padding: 0 2px; border-radius: 2px; }
pre code { background: none; padding: 0; font-size: inherit; }
table { border-collapse: collapse; margin: 8pt 0; font-size: 10pt; width: 100%; page-break-inside: avoid; }
th, td { border: 1px solid #c8d3e0; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #EEF3F9; font-family: Helvetica, Arial, sans-serif; }
blockquote { border-left: 4px solid #1F4E79; margin: 8pt 0; padding: 2pt 12pt; background: #FFF6D6; }
figure.diagram { margin: 10pt 0 14pt; page-break-inside: avoid; }
figure.diagram svg { width: 100%; height: auto; }
figcaption { text-align: center; font-size: 9.5pt; color: #555; font-style: italic; }
.diagram-legend { font-size: 9pt; margin: 0 0 4pt; font-family: Helvetica, Arial, sans-serif; }
.qs { page-break-before: always; } .qs > h2 { color: #5B3A8C; border-color: #5B3A8C; }
.q { border: 1px solid #d8d0e6; border-radius: 5px; padding: 6pt 10pt; margin: 10pt 0; page-break-inside: avoid; }
.tag { font-family: Helvetica, Arial, sans-serif; font-size: 9pt; font-weight: bold; color: #5B3A8C; }
ol.choices { list-style: upper-alpha; }
.hint { color: #555; font-style: italic; }
.answers { page-break-before: always; } .answers > h2 { color: #2e7d32; border-color: #2e7d32; }
.ans { border-left: 3px solid #2e7d32; padding-left: 10pt; margin: 12pt 0; }
.ans .tag { color: #2e7d32; }
.glossary dt { font-weight: bold; font-family: Helvetica, Arial, sans-serif; margin-top: 5pt; }
.glossary dd { margin: 0 0 0 14pt; }
`;

function buildPrintHtml(meta, content, { now = new Date() } = {}) {
  const chapters = content.chapters || [];
  const byChapter = new Map();
  for (const q of content.questions || []) {
    if (!byChapter.has(q.chapter)) byChapter.set(q.chapter, []);
    byChapter.get(q.chapter).push(q);
  }
  const roles = (meta.roleKeys || []).map((k) => k.replace('|', ', ')).join('; ');
  const body = [
    '<div class="cover">',
    `<h1>${esc(meta.title || 'Workbook')}</h1>`,
    roles ? `<p class="sub">${esc(roles)}</p>` : '',
    '<p>Chapters run in the order the topics come up in the interview. Read a chapter, try its practice questions out loud or on paper, then turn the page for the answers. Words in the glossary at the end are explained in plain English.</p>',
    `<p class="meta">Made ${esc(now.toISOString().slice(0, 10))} by Job Quest.</p>`,
    '<h2>Contents</h2><ol class="toc">',
    ...chapters.map((c) => `<li><a href="#ch-${esc(c.id)}">${esc(c.title)}</a></li>`),
    (content.glossary || []).length ? '<li><a href="#glossary">Glossary</a></li>' : '',
    '</ol></div>',
  ];
  for (const c of chapters) {
    const metaLine = [c.sub, c.mins ? `${c.mins} min read` : ''].filter(Boolean).join(' · ');
    body.push(`<section class="chapter" id="ch-${esc(c.id)}"><h1>${esc(c.title)}</h1>`);
    if (metaLine) body.push(`<div class="meta">${esc(metaLine)}</div>`);
    body.push(markdown(c.body, 1), '</section>');
    const qs = byChapter.get(c.id) || [];
    if (!qs.length) continue;
    body.push(`<section class="qs"><h2>Practice: ${esc(c.title)}</h2>`);
    qs.forEach((q, n) => {
      body.push(`<div class="q"><div class="tag">Q${n + 1} · ${esc(KIND[q.type] || q.type)} · difficulty ${esc(q.diff)}</div>`, markdown(q.body, 2));
      if (q.type === 'mcq') body.push(`<ol class="choices">${choices(q.choices).map((x) => `<li>${inline(x.text)}</li>`).join('')}</ol>`);
      if (q.hint) body.push(`<p class="hint">Hint: ${inline(String(q.hint).split(/\s+/).join(' ').trim())}</p>`);
      body.push('</div>');
    });
    body.push('</section>', `<section class="answers"><h2>Answers: ${esc(c.title)}</h2>`);
    qs.forEach((q, n) => {
      body.push(`<div class="ans"><div class="tag">Q${n + 1} answer</div>`);
      if (q.type === 'mcq') {
        const right = choices(q.choices).map((x, j) => (x.correct ? String.fromCharCode(65 + j) : null)).filter(Boolean);
        body.push(`<p><strong>Correct: ${right.join(', ')}</strong></p>`);
      }
      body.push(markdown(q.answer, 2));
      if (q.rubric) body.push('<p><strong>Check yourself:</strong></p>', markdown(q.rubric));
      body.push('</div>');
    });
    body.push('</section>');
  }
  const glossary = content.glossary || [];
  if (glossary.length) {
    body.push('<section class="chapter glossary" id="glossary"><h1>Glossary</h1><dl>');
    for (const g of glossary) body.push(`<dt>${esc(g.t)}</dt><dd>${inline(g.d)}</dd>`);
    body.push('</dl></section>');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title || 'Workbook')}</title><style>${CSS}</style></head><body>${body.join('\n')}</body></html>`;
}

module.exports = { buildPrintHtml, markdown, inline };
