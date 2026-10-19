// app/tests/workbook-pdf.test.js
// The plain-English workbook standard: diagram blocks, the system design structure check,
// and "Download offline" as a reading PDF.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDiagram, renderDiagram } = require('../lib/workbook/diagram');
const { lintWorkbook, SD_HEADINGS } = require('../lib/workbook/lint');
const { buildPrintHtml, markdown } = require('../lib/workbook/print');
const { findBrowser, htmlToPdf, PdfUnavailableError } = require('../lib/workbook/pdf');
const { withDiagramScript } = require('../lib/workbook/export');
const store = require('../lib/workbook/store');
const { writeKit } = require('./helpers/workbook-fixture');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pdf-'));

const GOOD = [
  'title: Jobs flow from the API to workers',
  'box api "Job API" "saves jobs" kind=service at=0,0',
  'box db "Jobs database" kind=store at=1,0',
  'box w "Workers" "run jobs" kind=service at=1,1',
  'arrow api -> db "insert row"',
  'arrow w <-> db "claim, finish"',
].join('\n');

test('diagram: parses boxes and arrows and draws an SVG with a caption and legend', () => {
  const d = parseDiagram(GOOD);
  assert.deepEqual(d.errors, []);
  assert.equal(d.boxes.length, 3);
  assert.equal(d.arrows[1].both, true);
  const html = renderDiagram(GOOD);
  assert.match(html, /<svg [^>]*viewBox="0 0 556 280"/);
  assert.match(html, /Jobs database/);
  assert.match(html, /marker-start=/);
  assert.match(html, /<figcaption>Jobs flow from the API to workers<\/figcaption>/);
  assert.match(html, /where data is stored/);
  assert.doesNotMatch(html, /someone else's service/);
});

test('diagram: explains every mistake in plain words', () => {
  const bad = [
    'box a "A" kind=planet at=0,0',
    'box a "Again" at=1,0',
    'box b "This title is far too long for one box" at=0,0',
    'box c "C" at=9,9',
    'box d "D"',
    'arrow a -> missing',
    'arrow a => b',
    'something else',
  ].join('\n');
  const errors = parseDiagram(bad).errors.join('\n');
  for (const want of ['kind must be one of', 'used twice', 'over 28 characters', 'same spot', 'outside the grid', 'needs at=col,row', 'unknown box "missing"', 'arrow lines are', 'lines start with']) {
    assert.ok(errors.includes(want), `missing: ${want}\n${errors}`);
  }
  assert.match(renderDiagram('box a "A" at=0,0'), /diagram-error/);
});

test('diagram: the format spec example is valid, and diagram.js can be inlined in a page', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', '..', 'skill', 'references', 'workbook', 'format-spec.md'), 'utf-8');
  const block = spec.match(/```diagram\n([\s\S]*?)```/);
  assert.ok(block, 'format spec shows a diagram');
  assert.deepEqual(parseDiagram(block[1]).errors, []);
  const page = withDiagramScript('<head><!--WB-DIAGRAM--></head>');
  assert.match(page, /<script>[\s\S]*WBDiagram[\s\S]*<\/script>/);
});

function chapterFile(topic, body) {
  return { name: 'c.md', text: `@@chapter id=ch1 company=both topic="${topic}" title="T"\n## In plain English\nPlain.\n${body}\n## Key takeaways\n- One.\n` };
}

test('lint: invalid diagrams are errors everywhere; the design structure is required only when generating', () => {
  const broken = chapterFile('Graphs', '```diagram\nbox a "A" at=0,0\narrow a -> b\n```');
  const rules = lintWorkbook({ files: [broken] }).filter((f) => f.severity === 'error').map((f) => f.rule);
  assert.ok(rules.includes('diagram'));

  const sparse = chapterFile('System design', 'Some notes.');
  assert.equal(lintWorkbook({ files: [sparse] }).filter((f) => f.rule === 'sd-structure').length, 0, 'imported kits are not held to it');
  const missing = lintWorkbook({ files: [sparse] }, { standard: true }).filter((f) => f.rule === 'sd-structure');
  assert.equal(missing.length, SD_HEADINGS.length);

  const full = chapterFile('System design', SD_HEADINGS.map((h) => `## ${h}\nText.${h === 'High-level design' ? `\n\`\`\`diagram\n${GOOD}\n\`\`\`` : ''}`).join('\n'));
  assert.deepEqual(lintWorkbook({ files: [full] }, { standard: true }).filter((f) => f.severity === 'error'), []);

  const noDiagram = chapterFile('System design', SD_HEADINGS.map((h) => `## ${h}\nText.`).join('\n'));
  const why = lintWorkbook({ files: [noDiagram] }, { standard: true }).filter((f) => f.rule === 'sd-structure');
  assert.equal(why.length, 1);
  assert.match(why[0].message, /diagram block under "## High-level design"/);
});

test('print: markdown subset renders tables, lists, code, diagrams and bold around code', () => {
  const html = markdown('## Head\n\n| A | B |\n|---|---|\n| **`x`** | 2 |\n\n- one\n  - nested\n- two\n\n```python\nprint(1 < 2)\n```\n\n```diagram\n' + GOOD + '\n```', 1);
  assert.match(html, /<h3>Head<\/h3>/);
  assert.match(html, /<td><strong><code>x<\/code><\/strong><\/td>/);
  assert.match(html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /print\(1 &lt; 2\)/);
  assert.match(html, /<figure class="diagram">/);
});

test('print: chapters in order, practice after each chapter, answers on their own page, glossary last', () => {
  const content = {
    chapters: [{ id: 'a', title: 'First topic', body: '## In plain English\nAlpha.' }, { id: 'b', title: 'Second topic', mins: 12, body: 'Beta.' }],
    questions: [
      { id: 'q1', chapter: 'a', type: 'mcq', diff: '1', body: 'Pick one.', choices: '- [ ] wrong\n- [x] right\n- [ ] also wrong', hint: '', answer: 'Right, because.', rubric: '' },
      { id: 'q2', chapter: 'a', type: 'open', diff: '2', body: 'Explain.', choices: '', hint: 'Think.', answer: 'Like this.', rubric: '- Said it' },
    ],
    glossary: [{ t: 'Lease', d: 'A claim that **expires**.' }],
  };
  const html = buildPrintHtml({ title: 'Prep: Acme', roleKeys: ['Acme|Staff Engineer'] }, content, { now: new Date('2026-10-18T00:00:00Z') });
  const order = ['First topic</h1>', 'Practice: First topic', 'Answers: First topic', 'Second topic</h1>', 'id="glossary"'].map((s) => html.indexOf(s));
  assert.ok(order.every((v) => v > 0), 'all sections present');
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'in reading order');
  assert.equal((html.match(/Practice: Second topic/g) || []).length, 0, 'no empty practice section');
  assert.match(html, /<strong>Correct: B<\/strong>/);
  assert.match(html, /Hint: Think\./);
  assert.match(html, /Check yourself/);
  assert.match(html, /<dd>A claim that <strong>expires<\/strong>\.<\/dd>/);
  assert.match(html, /Acme, Staff Engineer/);
  assert.match(html, /12 min read/);
});

test('pdf: finds a browser, honours the override, and explains when none is installed', async () => {
  assert.equal(findBrowser({ HOME: '/h' }, 'darwin', (p) => p === '/h/Applications/Chromium.app/Contents/MacOS/Chromium'), '/h/Applications/Chromium.app/Contents/MacOS/Chromium');
  assert.equal(findBrowser({ JOB_QUEST_PDF_BROWSER: '/x/chrome' }, 'linux', (p) => p === '/x/chrome'), '/x/chrome');
  assert.equal(findBrowser({}, 'linux', () => false), null);
  await assert.rejects(htmlToPdf('<p>x</p>', { browser: null }), PdfUnavailableError);
});

function fakeBrowser(dir) {
  const file = path.join(dir, 'fake-chrome.js');
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.find(x=>x.startsWith('--print-to-pdf='));const src=process.argv[process.argv.length-1].replace('file://','');fs.writeFileSync(a.split('=')[1],'%PDF-1.4 fake '+fs.readFileSync(src,'utf8').length);\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('pdf: htmlToPdf runs the browser headless and returns the PDF bytes', async () => {
  const dir = tmp();
  try {
    const bytes = await htmlToPdf('<p>hello</p>', { browser: fakeBrowser(dir) });
    assert.match(bytes.toString(), /^%PDF-1\.4 fake 12$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('route: GET /api/workbooks/:id/pdf?full=1 sends every chapter as a PDF, or a plain 503 when no browser exists', async () => {
  const { registerWorkbookRoutes } = require('../lib/workbook/routes');
  const dir = tmp();
  try {
    const meta = store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'], status: 'ready' });
    writeKit(store.wbDir(dir, meta.id));
    const run = async (pdfRenderer) => {
      const routes = new Map();
      const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((m) => [m, (url, fn) => routes.set(`${m} ${url}`, fn)]));
      registerWorkbookRoutes(app, { dataDir: dir, queue: { list: () => [] }, autoBuild: {}, publicDir: path.join(__dirname, '..', 'public'), pdfRenderer });
      const res = { headers: {}, statusCode: 200, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; }, json(b) { this.body = b; } };
      await routes.get('get /api/workbooks/:id/pdf')({ params: { id: meta.id }, query: { full: '1' } }, res);
      return res;
    };
    let seen = '';
    const ok = await run(async (html) => { seen = html; return Buffer.from('%PDF-1.4 x'); });
    assert.equal(ok.headers['Content-Type'], 'application/pdf');
    assert.match(ok.headers['Content-Disposition'], new RegExp(`${meta.id}-full\\.pdf`));
    assert.equal(ok.body.toString(), '%PDF-1.4 x');
    assert.match(seen, /class="chapter"/);
    const none = await run(async () => { throw new PdfUnavailableError('No Chrome found'); });
    assert.equal(none.statusCode, 503);
    assert.equal(none.body.error, 'No Chrome found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('viewer and dashboard: Download offline points at the PDF; the viewer draws diagrams', () => {
  const viewer = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbook.html'), 'utf-8');
  assert.match(viewer, /\/pdf">Download study guide \(PDF\)/);
  assert.match(viewer, /<!--WB-DIAGRAM-->/);
  assert.match(viewer, /WBDiagram\.renderDiagram/);
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  assert.match(dash, /\/api\/workbooks\/\$\{wb\.id\}\/pdf`\}[^>]*>Download offline</);
});
