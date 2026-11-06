// app/tests/workbook-restructure.test.js
// Rewriting existing system design chapters into the delivery framework.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/workbook/store');
const { SD_HEADINGS } = require('../lib/workbook/lint');
const r = require('../lib/workbook/restructure');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restructure-'));

const FILE = [
  '@@chapter id=intro company=both topic="Graphs" title="Graphs"',
  '## In plain English', '', 'Graphs.', '', '## Key takeaways', '', '- One.', '',
  '@@chapter id=queue company=acme topic="System design" title="Design a task queue"',
  '## In plain English', '', 'Lots of facts about queues.', '', '## Key takeaways', '', '- Leases.', '',
  '@@q id=queue-1 company=acme topic="System design" type=open diff=2 chapter=queue',
  'How do you stop two workers taking one task?',
  '@@rubric', '- Mentions a lease', '@@answer', 'Use a lease.', '',
].join('\n');

const GOOD_BODY = ['## In plain English', '', 'Plain.', '',
  ...SD_HEADINGS.flatMap((h) => [`## ${h}`, '', `Explained ${h}.`, '', ...(h === 'High-level design' ? ['```diagram', 'box a "Workers" at=0,0', 'box b "Queue table" kind=store at=1,0', 'arrow a <-> b "claim"', '```', ''] : [])]),
  '## Key takeaways', '', '- Claim with a lease.'].join('\n');

function seed(dir) {
  const meta = store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'], status: 'ready' });
  fs.writeFileSync(path.join(store.wbDir(dir, meta.id), 'content', '10-acme.md'), FILE);
  return meta;
}

test('candidates are the system design chapters that lack the delivery framework', () => {
  const dir = tmp();
  try {
    const meta = seed(dir);
    assert.deepEqual(r.candidates(dir, meta.id).map((c) => c.id), ['queue']);
    const file = path.join(store.wbDir(dir, meta.id), 'content', '10-acme.md');
    fs.writeFileSync(file, r.splice(FILE, 'queue', GOOD_BODY));
    assert.deepEqual(r.candidates(dir, meta.id), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('splice replaces only the chapter body; headers and questions stay byte for byte', () => {
  const out = r.splice(FILE, 'queue', GOOD_BODY);
  assert.ok(out.includes('@@chapter id=queue company=acme topic="System design" title="Design a task queue"\n## In plain English\n\nPlain.'));
  assert.ok(out.endsWith(FILE.slice(FILE.indexOf('@@q id=queue-1'))));
  assert.ok(out.startsWith(FILE.slice(0, FILE.indexOf('@@chapter id=queue'))));
  assert.doesNotMatch(out, /Lots of facts about queues/);
  assert.equal(r.locate(FILE, 'missing'), null);
});

function agentWriting(bodies) {
  const calls = [];
  return {
    calls,
    runAgent: async (args) => {
      calls.push(args);
      const body = bodies[calls.length - 1];
      if (body !== undefined) fs.writeFileSync(path.join(args.cwd, `${args.agent.replace(/^restructure-/, '').replace(/-fix$/, '')}.body.md`), body);
      return { ok: true };
    },
  };
}

test('handler rewrites a chapter, backs up the original, and refreshes lint', async () => {
  const dir = tmp();
  try {
    const meta = seed(dir);
    const { runAgent, calls } = agentWriting([GOOD_BODY]);
    const out = await r.createRestructureHandler({ dataDir: dir, runAgent, readProfile: () => ({}) })({ payload: { workbookId: meta.id } });
    assert.deepEqual(out, { workbookId: meta.id, rewritten: 1, failed: 0 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Lots of facts about queues/);
    assert.match(calls[0].prompt, /How do you stop two workers taking one task\?/);
    assert.match(calls[0].prompt, /## Functional requirements/);
    const wb = store.wbDir(dir, meta.id);
    const now = fs.readFileSync(path.join(wb, 'content', '10-acme.md'), 'utf-8');
    assert.match(now, /## Core entities/);
    assert.match(now, /@@q id=queue-1/);
    const backups = fs.readdirSync(path.join(wb, 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(wb, 'backups', backups[0]), 'utf-8'), FILE);
    assert.equal(r.readState(dir, meta.id).chapters.queue.status, 'rewritten');
    assert.ok(fs.existsSync(path.join(wb, 'lint.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handler gives one fix round, and a chapter that still fails is left untouched', async () => {
  const dir = tmp();
  try {
    const meta = seed(dir);
    const missingApi = GOOD_BODY.replace('## API', '## Calls');
    const { runAgent, calls } = agentWriting([missingApi, missingApi]);
    const out = await r.createRestructureHandler({ dataDir: dir, runAgent, readProfile: () => ({}) })({ payload: { workbookId: meta.id } });
    assert.deepEqual([out.rewritten, out.failed], [0, 1]);
    assert.equal(calls[1].agent, 'restructure-queue-fix');
    assert.match(calls[1].prompt, /missing the heading "## API"/);
    assert.equal(fs.readFileSync(path.join(store.wbDir(dir, meta.id), 'content', '10-acme.md'), 'utf-8'), FILE);
    const state = r.readState(dir, meta.id);
    assert.equal(state.status, 'partial');
    assert.match(state.chapters.queue.error, /## API/);

    const fixed = agentWriting(['@@chapter id=x\n' + GOOD_BODY, GOOD_BODY]);
    const again = await r.createRestructureHandler({ dataDir: dir, runAgent: fixed.runAgent, readProfile: () => ({}) })({ payload: { workbookId: meta.id } });
    assert.equal(again.rewritten, 1);
    assert.match(fixed.calls[1].prompt, /body only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routes report candidates and queue one rewrite job', async () => {
  const { registerWorkbookRoutes } = require('../lib/workbook/routes');
  const dir = tmp();
  try {
    const meta = seed(dir);
    const enqueued = [];
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((m) => [m, (url, fn) => routes.set(`${m} ${url}`, fn)]));
    registerWorkbookRoutes(app, { dataDir: dir, queue: { list: () => [], findActiveByKey: () => null, enqueue: (j) => { enqueued.push(j); return { id: 'j1', status: 'queued' }; } }, autoBuild: {}, publicDir: path.join(__dirname, '..', 'public') });
    const res = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
    const g = res();
    await routes.get('get /api/workbooks/:id/restructure')({ params: { id: meta.id } }, g);
    assert.deepEqual(g.body.candidates.map((c) => c.id), ['queue']);
    const p = res();
    await routes.get('post /api/workbooks/:id/restructure')({ params: { id: meta.id }, body: {} }, p);
    assert.equal(p.statusCode, 202);
    assert.deepEqual(enqueued.map((j) => [j.kind, j.key, j.payload.workbookId]), [['workbook-restructure', `workbook-restructure:${meta.id}`, meta.id]]);
    const l = res();
    await routes.get('get /api/workbooks')({ params: {}, query: {} }, l);
    const item = (Array.isArray(l.body) ? l.body : l.body.workbooks).find((w) => w.id === meta.id);
    assert.equal(item.designToRewrite, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
