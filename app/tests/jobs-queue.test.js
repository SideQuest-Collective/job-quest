// app/tests/jobs-queue.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQueue } = require('../lib/jobs/queue');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jq-queue-')); }
function clock(iso) { let t = new Date(iso); return { now: () => t, set: (s) => { t = new Date(s); } }; }

test('queue saves keep separate payloads when writes interleave', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createQueue({ dataDir: dir, handlers: {} });
  const second = createQueue({ dataDir: dir, handlers: {} });
  const file = path.join(dir, 'jobs', 'queue.json');
  const opts = { auto: true, capName: 'workbooks', cap: 0 };
  const rename = fs.renameSync;
  const temps = [];
  t.mock.method(fs, 'renameSync', (temp, destination) => {
    temps.push(temp);
    if (temps.length === 1) {
      second.enqueue({ kind: 'w', key: 'second' }, opts);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.map((job) => job.key), ['second']);
    }
    rename(temp, destination);
  });
  first.enqueue({ kind: 'w', key: 'first' }, opts);
  assert.equal(new Set(temps).size, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ jobs: first.list(), counts: {} }, null, 2));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['queue.json']);
});

test('runs jobs FIFO, one at a time, and records results', async () => {
  const order = [];
  let running = 0, maxRunning = 0;
  const q = createQueue({ dataDir: tmp(), handlers: { w: async (job) => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    order.push(job.key); running--; return { ok: job.key };
  } } });
  q.enqueue({ kind: 'w', key: 'a', payload: {} });
  q.enqueue({ kind: 'w', key: 'b', payload: {} });
  await q.drain();
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(maxRunning, 1);
  assert.deepEqual(q.list().map((j) => j.status), ['done', 'done']);
  assert.deepEqual(q.list()[0].result, { ok: 'a' });
});

test('dedupes by key while queued, running, or deferred', async () => {
  const q = createQueue({ dataDir: tmp(), handlers: { w: async () => ({}) } });
  assert.equal(q.enqueue({ kind: 'w', key: 'a', payload: {} }).status, 'queued');
  assert.equal(q.enqueue({ kind: 'w', key: 'a', payload: {} }).status, 'duplicate');
  await q.drain();
  assert.equal(q.enqueue({ kind: 'w', key: 'a', payload: {} }).status, 'queued');
});

test('handler errors mark the job failed without stopping the queue', async () => {
  const q = createQueue({ dataDir: tmp(), handlers: { w: async (job) => { if (job.key === 'bad') throw new Error('boom'); return {}; } } });
  q.enqueue({ kind: 'w', key: 'bad', payload: {} });
  q.enqueue({ kind: 'w', key: 'good', payload: {} });
  await q.drain();
  const [bad, good] = q.list();
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /boom/);
  assert.equal(good.status, 'done');
});

test('auto jobs over the daily cap are deferred and promoted the next day in order', async () => {
  const c = clock('2026-10-05T12:00:00');
  const dir = tmp();
  const ran = [];
  const q = createQueue({ dataDir: dir, now: c.now, handlers: { w: async (job) => { ran.push(job.key); return {}; } } });
  const opts = { auto: true, capName: 'workbooks', cap: 2 };
  assert.equal(q.enqueue({ kind: 'w', key: 'a', payload: {} }, opts).status, 'queued');
  assert.equal(q.enqueue({ kind: 'w', key: 'b', payload: {} }, opts).status, 'queued');
  assert.equal(q.enqueue({ kind: 'w', key: 'c', payload: {} }, opts).status, 'deferred');
  assert.equal(q.enqueue({ kind: 'w', key: 'd', payload: {} }, opts).status, 'deferred');
  await q.drain();
  assert.deepEqual(ran, ['a', 'b']);
  c.set('2026-10-06T08:00:00');
  await q.tick();
  assert.deepEqual(ran, ['a', 'b', 'c', 'd']);
});

test('manual jobs ignore the cap', () => {
  const q = createQueue({ dataDir: tmp(), handlers: { w: async () => ({}) } });
  const opts = { auto: false, capName: 'workbooks', cap: 0 };
  assert.equal(q.enqueue({ kind: 'w', key: 'a', payload: {} }, opts).status, 'queued');
});

test('a job left running by a crash is resumed on restart', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', 'queue.json'), JSON.stringify({ jobs: [
    { id: 'j1', kind: 'w', key: 'a', payload: {}, status: 'running', createdAt: '2026-10-05T00:00:00.000Z' },
  ], counts: {} }));
  const ran = [];
  const q = createQueue({ dataDir: dir, handlers: { w: async (job) => { ran.push(job.id); return {}; } } });
  assert.equal(q.get('j1').status, 'queued');
  await q.drain();
  assert.deepEqual(ran, ['j1']);
});

test('ctx.update persists progress', async () => {
  const dir = tmp();
  const q = createQueue({ dataDir: dir, handlers: { w: async (job, ctx) => { ctx.update({ step: 'write', done: 2, total: 6 }); return {}; } } });
  const { id } = q.enqueue({ kind: 'w', key: 'a', payload: {} });
  await q.drain();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', 'queue.json'), 'utf-8'));
  assert.deepEqual(saved.jobs.find((j) => j.id === id).progress, { step: 'write', done: 2, total: 6 });
});
