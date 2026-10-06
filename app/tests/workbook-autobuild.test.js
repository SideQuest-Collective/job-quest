// app/tests/workbook-autobuild.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQueue } = require('../lib/jobs/queue');
const { writeSettings } = require('../lib/jobs/settings');
const { createAutoBuild } = require('../lib/workbook/autobuild');
const store = require('../lib/workbook/store');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auto-')); }
function clock(iso) { let t = new Date(iso); return { now: () => t, set: (s) => { t = new Date(s); } }; }
function rig(dataDir, now = () => new Date('2026-10-05T12:00:00')) {
  const ran = [];
  const queue = createQueue({ dataDir, now, handlers: { workbook: async (job) => { ran.push(job.payload.workbookId); return {}; } } });
  return { queue, ran, auto: createAutoBuild({ dataDir, queue, now }) };
}

test('manual enqueue creates a workbook and one create job; repeats return the existing workbook', async () => {
  const dir = tmp();
  const { queue, auto } = rig(dir);
  const a = auto.enqueueWorkbook('Acme|Staff Engineer');
  assert.deepEqual([a.status, a.workbook.id, a.workbook.trigger], ['queued', 'acme-staff-engineer', 'manual']);
  const b = auto.enqueueWorkbook('Acme|Staff Engineer');
  assert.deepEqual([b.status, b.workbook.id], ['exists', 'acme-staff-engineer']);
  await queue.drain();
  const jobs = queue.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].key, 'workbook:acme-staff-engineer');
  assert.deepEqual(jobs[0].payload, { workbookId: 'acme-staff-engineer', mode: 'create' });
  assert.equal(auto.enqueueWorkbook('no pipe').status, 'invalid');
});

test('the same role saved twice, then applied, makes exactly one workbook', async () => {
  const dir = tmp();
  const { queue, auto } = rig(dir);
  const statuses = [auto.onRoleEvent('saved', 'Acme|Eng'), auto.onRoleEvent('saved', 'Acme|Eng'), auto.onRoleEvent('applied', 'Acme|Eng')].map((r) => r.status);
  assert.deepEqual(statuses, ['queued', 'exists', 'exists']);
  assert.equal(store.listWorkbooks(dir).length, 1);
  assert.equal(store.listWorkbooks(dir)[0].trigger, 'auto-saved');
  await queue.drain();
  assert.equal(queue.list().length, 1);
});

test('applied-first is tagged auto-applied; the off switch blocks auto builds but not manual ones', () => {
  const dir = tmp();
  const { auto } = rig(dir);
  assert.equal(auto.onRoleEvent('applied', 'Beta|Eng').workbook.trigger, 'auto-applied');
  writeSettings(dir, { workbooks: { autoBuild: false } });
  assert.equal(auto.onRoleEvent('saved', 'Gamma|Eng').status, 'disabled');
  assert.equal(store.findByRoleKey(dir, 'Gamma|Eng'), null);
  assert.equal(auto.enqueueWorkbook('Gamma|Eng').status, 'queued');
});

test('the daily cap defers extra auto builds and promotes them the next day, in order', async () => {
  const c = clock('2026-10-05T12:00:00');
  const dir = tmp();
  const { queue, auto, ran } = rig(dir, c.now);
  const statuses = ['A|x', 'B|x', 'C|x', 'D|x', 'E|x'].map((k) => auto.onRoleEvent('saved', k).status);
  assert.deepEqual(statuses, ['queued', 'queued', 'queued', 'deferred', 'deferred']);
  assert.equal(store.findByRoleKey(dir, 'D|x').status, 'deferred');
  assert.equal(store.findByRoleKey(dir, 'E|x').status, 'deferred');
  assert.equal(store.listWorkbooks(dir).length, 5);
  assert.equal(auto.enqueueWorkbook('F|x').status, 'queued');
  await queue.drain();
  assert.deepEqual(ran, ['a-x', 'b-x', 'c-x', 'f-x']);
  c.set('2026-10-06T08:00:00');
  await queue.tick();
  assert.deepEqual(ran, ['a-x', 'b-x', 'c-x', 'f-x', 'd-x', 'e-x']);
});

test('an interview-only workbook is generated into in place, not treated as existing', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'role-actions.json'), JSON.stringify({ saved: ['Acme|Eng'], skipped: [], applied: [] }));
  const { queue, auto } = rig(dir);
  const m = store.createMinimal(dir, { roleKey: 'Acme|Eng', company: 'Acme', role: 'Eng', source: 'interview' });
  store.appendChapterQuestions(dir, m.id, { questions: [{ id: 'iv-1', markup: '@@q id=iv-1 company=acme topic="Interviews" type=open diff=2 chapter=asked-in-interviews\nQ?\n@@rubric\n- r\n@@answer\na' }] });
  assert.deepEqual(auto.backfillCandidates(), ['Acme|Eng']);
  const r = auto.onRoleEvent('saved', 'Acme|Eng');
  assert.deepEqual([r.status, r.workbook.id], ['queued', m.id]);
  const after = store.readMeta(dir, m.id);
  assert.deepEqual([after.source, after.status, after.trigger], ['generated', 'queued', 'auto-saved']);
  assert.equal(store.listWorkbooks(dir).length, 1);
  assert.ok(fs.existsSync(path.join(store.wbDir(dir, m.id), 'content', '99-asked-in-interviews.md')));
  assert.equal(auto.onRoleEvent('applied', 'Acme|Eng').status, 'exists');
  assert.deepEqual(auto.backfillCandidates(), []);
  await queue.drain();
  assert.deepEqual(queue.list().map((j) => j.payload.workbookId), [m.id]);
});

test('backfill covers saved and applied roles lacking a workbook, capped, even with auto-build off', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'role-actions.json'), JSON.stringify({ saved: ['A|x', 'B|x'], skipped: ['Z|x'], applied: ['C|x', 'A|x'] }));
  fs.writeFileSync(path.join(dir, 'role-tracker.json'), JSON.stringify({ 'D|x': { stage: 'applied' }, 'E|x': { stage: 'researching' } }));
  writeSettings(dir, { workbooks: { autoBuild: false, autoDailyCap: 2 } });
  const { auto } = rig(dir);
  auto.enqueueWorkbook('B|x');
  assert.deepEqual(auto.backfillCandidates(), ['A|x', 'C|x', 'D|x']);
  assert.deepEqual(auto.backfill().map((r) => [r.roleKey, r.status, r.workbook.status]), [['A|x', 'queued', 'queued'], ['C|x', 'queued', 'queued'], ['D|x', 'deferred', 'deferred']]);
  assert.equal(store.findByRoleKey(dir, 'D|x').status, 'deferred');
  assert.deepEqual(auto.backfillCandidates(), []);
  assert.equal(store.findByRoleKey(dir, 'A|x').trigger, 'backfill');
});

test('direct auto enqueue persists and returns deferred metadata', () => {
  const dir = tmp();
  writeSettings(dir, { workbooks: { autoDailyCap: 0 } });
  const { auto } = rig(dir);
  const result = auto.enqueueWorkbook('Deferred|Eng', { auto: true });
  assert.equal(result.status, 'deferred');
  assert.equal(result.workbook.status, 'deferred');
  assert.equal(store.readMeta(dir, result.workbook.id).status, 'deferred');
});

test('duplicate interview conversion restores its pre-call status', () => {
  const dir = tmp();
  const meta = store.createMinimal(dir, { roleKey: 'Interview|Eng' });
  const { queue, auto } = rig(dir);
  const first = queue.enqueue({ kind: 'workbook', key: `workbook:${meta.id}`, payload: { workbookId: meta.id, mode: 'create' } },
    { auto: true, capName: 'workbooks', cap: 0 });
  const result = auto.enqueueWorkbook('Interview|Eng');
  assert.equal(result.status, 'duplicate');
  assert.equal(result.jobId, first.id);
  assert.equal(result.workbook.status, meta.status);
  assert.equal(store.readMeta(dir, meta.id).status, meta.status);
  assert.equal(queue.list().length, 1);
});

test('queued enqueue returns the metadata written by a synchronously started handler', async () => {
  const dir = tmp();
  let observed;
  const queue = createQueue({ dataDir: dir, handlers: { workbook: async (job) => {
    const meta = store.readMeta(dir, job.payload.workbookId);
    observed = meta.status;
    store.writeMeta(dir, { ...meta, status: 'generating' });
  } } });
  const auto = createAutoBuild({ dataDir: dir, queue });
  const result = auto.enqueueWorkbook('Immediate|Eng');
  assert.equal(observed, 'queued');
  assert.equal(result.status, 'queued');
  assert.equal(result.workbook.status, 'generating');
  assert.equal(store.readMeta(dir, result.workbook.id).status, 'generating');
  await queue.drain();
});
