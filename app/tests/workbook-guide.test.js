// app/tests/workbook-guide.test.js
// "Download offline" = a short study guide: predicted questions in plain English, at most 15 pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/workbook/store');
const guide = require('../lib/workbook/guide');
const { writeKit } = require('./helpers/workbook-fixture');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-guide-'));
const fakePdf = (pages) => Buffer.from(`%PDF-1.4\n${Array.from({ length: pages }, () => '<< /Type /Page >>').join('\n')}\n<< /Type /Pages >>`);
const okPython = () => null;

const GOOD = [
  '# Acme: study guide',
  '',
  'The questions most likely to come up.',
  '',
  '## System design',
  '',
  '### Predicted: design a job scheduler',
  '',
  'Reported twice.',
  '',
  '```diagram',
  'box a "API" kind=service at=0,0',
  'box b "Database" kind=store at=1,0',
  'arrow a -> b "saves jobs"',
  '```',
  '',
  '```python',
  'def f(x):',
  '    return x + 1',
  '```',
  '',
  '#### Same family',
  '',
  'A related question.',
].join('\n');

function seed(dir, { notes } = {}) {
  const meta = store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'], status: 'ready' });
  writeKit(store.wbDir(dir, meta.id));
  if (notes) fs.writeFileSync(path.join(dir, 'role-tracker.json'), JSON.stringify({ 'Acme|Staff Engineer': { stage: 'onsite', notes } }));
  return meta;
}

test('checkGuide accepts a plain guide and explains every problem it finds', () => {
  assert.deepEqual(guide.checkGuide(GOOD, { pythonCheck: okPython }), []);
  const bad = [
    'no title here',
    '@@q id=x',
    '- [x] a multiple-choice option',
    '```diagram',
    'box a "A" at=0,0',
    '```',
    '```python',
    'def broken(:',
    '```',
    ...Array.from({ length: guide.MAX_WORDS + 10 }, () => 'word'),
  ].join('\n');
  const problems = guide.checkGuide(bad, { pythonCheck: (code) => (code.includes('broken(') ? 'SyntaxError: invalid syntax' : null) }).join('\n');
  for (const want of ['`#` title', '### Predicted:', '`@@`', 'multiple-choice', 'Diagram starting on line 4', 'Python block 1 does not parse', `at most ${guide.MAX_WORDS}`]) {
    assert.ok(problems.includes(want), `missing: ${want}\n${problems}`);
  }
});

test('countPdfPages counts page objects, not the page tree', () => {
  assert.equal(guide.countPdfPages(fakePdf(7)), 7);
});

test('guideInputs: imported kits use tracker notes and company chapters; the hash follows the inputs', () => {
  const dir = tmp();
  try {
    const meta = seed(dir, { notes: 'Predicted: job scheduler design.' });
    const a = guide.guideInputs(dir, meta.id);
    assert.match(a.source, /Notes from the role tracker[\s\S]*Predicted: job scheduler design/);
    assert.match(a.source, /Company-specific workbook chapters/);
    assert.match(a.outline, /^- /);
    fs.writeFileSync(path.join(dir, 'role-tracker.json'), JSON.stringify({ 'Acme|Staff Engineer': { notes: 'New research.' } }));
    assert.notEqual(guide.guideInputs(dir, meta.id).hash, a.hash);
    fs.writeFileSync(path.join(store.wbDir(dir, meta.id), 'research.md'), '## Reported questions\n- Design a queue.\n');
    const withResearch = guide.guideInputs(dir, meta.id);
    assert.match(withResearch.source, /Design a queue/);
    assert.doesNotMatch(withResearch.source, /Company-specific workbook chapters/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the guide prompt carries the limits, research, diagram rules and fix list', () => {
  const dir = tmp();
  try {
    const meta = seed(dir, { notes: 'Scheduler.' });
    const inputs = guide.guideInputs(dir, meta.id);
    const p = guide.guidePrompt({ meta, profile: { name: 'Sam' }, inputs, mode: 'fix', problems: ['Cut it down.'] });
    for (const want of [`At most ${guide.MAX_PAGES} printed pages`, 'No multiple-choice questions', '<research>', 'Scheduler.', '## Diagrams', 'box <id>', '- Cut it down.', 'Sam']) {
      assert.ok(p.includes(want), `prompt is missing: ${want}`);
    }
    assert.doesNotMatch(p, /\{\{\w+\}\}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writerThat(texts) {
  const calls = [];
  const runAgent = async (args) => {
    calls.push(args);
    const text = texts[calls.length - 1];
    if (text !== undefined) fs.writeFileSync(path.join(args.cwd, 'guide.md'), text);
    return { ok: true, code: 0 };
  };
  return { runAgent, calls };
}

test('handler: a clean guide is printed, cached with its hash, and the draft is removed', async () => {
  const dir = tmp();
  try {
    const meta = seed(dir);
    const { runAgent, calls } = writerThat([GOOD]);
    const handler = guide.createGuideHandler({ dataDir: dir, runAgent, htmlToPdf: async (html) => { assert.match(html, /<svg /); return fakePdf(6); }, pythonCheck: okPython, readProfile: () => ({}) });
    const out = await handler({ payload: { workbookId: meta.id } });
    assert.equal(out.status, 'ready');
    assert.equal(out.pages, 6);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profile, 'write');
    assert.equal(path.basename(calls[0].cwd), 'drafts');
    const wb = store.wbDir(dir, meta.id);
    assert.equal(fs.readFileSync(path.join(wb, 'guide.md'), 'utf-8'), GOOD);
    assert.ok(fs.existsSync(path.join(wb, 'guide.pdf')));
    assert.ok(!fs.existsSync(path.join(wb, 'drafts', 'guide.md')));
    assert.equal(guide.readGuideState(dir, meta.id).hash, guide.guideInputs(dir, meta.id).hash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handler: too many pages gets one fix round with the page count in the prompt', async () => {
  const dir = tmp();
  try {
    const meta = seed(dir);
    const { runAgent, calls } = writerThat([GOOD, `${GOOD}\n\nShorter now.`]);
    let n = 0;
    const handler = guide.createGuideHandler({ dataDir: dir, runAgent, htmlToPdf: async () => fakePdf(n++ ? 12 : 22), pythonCheck: okPython, readProfile: () => ({}) });
    const out = await handler({ payload: { workbookId: meta.id } });
    assert.equal(out.pages, 12);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].agent, 'guide-fix');
    assert.match(calls[1].prompt, /prints as 22 pages; cut it to at most 15/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handler: two failed drafts record a plain failure and keep any previous guide', async () => {
  const dir = tmp();
  try {
    const meta = seed(dir);
    const wb = store.wbDir(dir, meta.id);
    fs.writeFileSync(path.join(wb, 'guide.pdf'), fakePdf(3));
    const { runAgent, calls } = writerThat(['- [x] option', '- [x] still options']);
    const handler = guide.createGuideHandler({ dataDir: dir, runAgent, htmlToPdf: async () => fakePdf(3), pythonCheck: okPython, readProfile: () => ({}) });
    await assert.rejects(handler({ payload: { workbookId: meta.id } }), /multiple-choice/);
    assert.equal(calls.length, 2);
    const state = guide.readGuideState(dir, meta.id);
    assert.equal(state.status, 'failed');
    assert.match(state.error, /multiple-choice/);
    assert.equal(state.hash, guide.guideInputs(dir, meta.id).hash);
    assert.equal(guide.countPdfPages(fs.readFileSync(path.join(wb, 'guide.pdf'))), 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('route: writes on first download, serves the cached guide, offers retry after a failure', async () => {
  const { registerWorkbookRoutes } = require('../lib/workbook/routes');
  const dir = tmp();
  try {
    const meta = seed(dir);
    const enqueued = [];
    let active = null;
    const queue = { list: () => [], enqueue: (j) => { enqueued.push(j); return { status: 'queued' }; }, findActiveByKey: () => active };
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((m) => [m, (url, fn) => routes.set(`${m} ${url}`, fn)]));
    registerWorkbookRoutes(app, { dataDir: dir, queue, autoBuild: {}, publicDir: path.join(__dirname, '..', 'public') });
    const get = async (query = {}) => {
      const res = { headers: {}, statusCode: 200, set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
      await routes.get('get /api/workbooks/:id/pdf')({ params: { id: meta.id }, query }, res);
      return res;
    };

    const first = await get();
    assert.equal(first.statusCode, 202);
    assert.match(first.body, /Writing your study guide/);
    assert.match(first.body, /http-equiv="refresh"/);
    assert.deepEqual(enqueued.map((j) => [j.kind, j.key]), [['workbook-guide', `workbook-guide:${meta.id}`]]);

    active = { id: 'running' };
    assert.equal((await get()).statusCode, 202);
    assert.equal(enqueued.length, 1, 'no second job while one is running');
    active = null;

    const wb = store.wbDir(dir, meta.id);
    fs.writeFileSync(path.join(wb, 'guide.pdf'), fakePdf(9));
    fs.writeFileSync(path.join(wb, 'guide.json'), JSON.stringify({ status: 'ready', hash: guide.guideInputs(dir, meta.id).hash, pages: 9 }));
    const ready = await get();
    assert.equal(ready.headers['Content-Type'], 'application/pdf');
    assert.match(ready.headers['Content-Disposition'], /-study-guide\.pdf/);
    assert.equal(guide.countPdfPages(ready.body), 9);

    fs.writeFileSync(path.join(dir, 'role-tracker.json'), JSON.stringify({ 'Acme|Staff Engineer': { notes: 'New intel.' } }));
    const stale = await get();
    assert.equal(stale.statusCode, 202, 'research changed, so the guide is rewritten');
    assert.match(stale.body, /previous=1/);
    assert.equal(enqueued.length, 2);
    assert.equal(guide.countPdfPages((await get({ previous: '1' })).body), 9);

    fs.writeFileSync(path.join(wb, 'guide.json'), JSON.stringify({ status: 'failed', hash: guide.guideInputs(dir, meta.id).hash, error: 'The guide prints as 30 pages.' }));
    const failed = await get();
    assert.equal(failed.statusCode, 500);
    assert.match(failed.body, /could not be written[\s\S]*30 pages[\s\S]*retry=1/);
    assert.equal(enqueued.length, 2, 'a failure is not retried automatically');
    assert.equal((await get({ retry: '1' })).statusCode, 202);
    assert.equal(enqueued.length, 3);
    assert.equal(guide.readGuideState(dir, meta.id).status, 'queued');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
