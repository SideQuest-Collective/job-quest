// app/tests/resume-extract.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractPdf, buildLines } = require('../lib/resume/grade');
const { compileTex, findTectonic } = require('../lib/resume/render');
const { minimalPdf } = require('./helpers/minimal-pdf');
const { tmpDir } = require('./helpers/resume-fixtures');

const skip = findTectonic() ? false : 'tectonic not installed';

async function compile(body) {
  const dir = tmpDir();
  const texPath = path.join(dir, 'x.tex');
  fs.writeFileSync(texPath, ['\\documentclass[11pt]{article}', '\\usepackage[T1]{fontenc}', '\\usepackage{lmodern}', '\\usepackage{enumitem}', '\\begin{document}', ...body, '\\end{document}', ''].join('\n'));
  const r = await compileTex({ texPath });
  assert.equal(r.ok, true, r.log);
  return r.pdfPath;
}

test('buildLines groups by baseline, orders by x, inserts spaces at gaps, decomposes ligatures', () => {
  const it = (str, x, y, width, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width });
  const lines = buildLines([it('World', 60, 700, 25), it('Hello', 20, 700.5, 25), it('Next', 20, 680, 20), it('ﬁle', 50, 680, 12)], 1);
  assert.deepEqual(lines.map((l) => l.text), ['Hello World', 'Next file']);
  assert.equal(lines[0].x, 20);
  assert.equal(lines[1].page, 1);
});

test('a PDF with a non-embedded base-14 font: text extracted, fontsEmbedded false', async () => {
  const file = path.join(tmpDir(), 'plain.pdf');
  fs.writeFileSync(file, minimalPdf(['Hello World', 'Second line']));
  const ex = await extractPdf(file);
  assert.equal(ex.pages, 1);
  assert.deepEqual(ex.lines.map((l) => l.text), ['Hello World', 'Second line']);
  assert.equal(ex.text, 'Hello World\nSecond line');
  assert.equal(ex.fontsEmbedded, false);
});

test('Tectonic PDF: one page, embedded fonts, hanging bullet indent, ASCII-clean ligatures', { skip, timeout: 300000 }, async () => {
  const pdf = await compile([
    'Summary', '', 'An efficient offline workflow.',
    '\\begin{itemize}[leftmargin=0.15in,label=\\textbullet]',
    `\\item ${'Long bullet text that wraps onto a second line because it keeps going with more words. '.repeat(3)}`,
    '\\end{itemize}',
  ]);
  const ex = await extractPdf(pdf);
  assert.equal(ex.pages, 1);
  assert.equal(ex.fontsEmbedded, true);
  assert.ok(ex.lines.some((l) => l.text === 'Summary'), ex.text);
  assert.ok(ex.text.includes('An efficient offline workflow.'), ex.text);
  const b = ex.lines.findIndex((l) => l.text.startsWith('•'));
  assert.ok(b >= 0, ex.text);
  assert.ok(ex.lines[b + 1].x > ex.lines[b].x + 1, 'continuation line is indented past the bullet');
  assert.ok(![...ex.text].some((ch) => ch.charCodeAt(0) > 127 && !'–’•“”|'.includes(ch)), ex.text);
});

test('Tectonic PDF with a page break has 2 pages; extraction is deterministic', { skip, timeout: 300000 }, async () => {
  const pdf = await compile(['Page one.', '\\newpage', 'Page two.']);
  const a = await extractPdf(pdf);
  const b = await extractPdf(pdf);
  assert.equal(a.pages, 2);
  assert.deepEqual(a, b);
  assert.deepEqual([...new Set(a.lines.map((l) => l.page))], [1, 2]);
  assert.ok(a.lines.some((l) => l.page === 2 && l.text.includes('Page two.')));
});
