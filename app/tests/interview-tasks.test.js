// app/tests/interview-tasks.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { upsertTasks, missingTaskKeys, isValidDate } = require('../lib/interview/task-effects');
const { makeEnv, readJson, pinned } = require('./helpers/interview-env');

const now = pinned('2026-10-05T12:00:00');
const file = (dataDir, date) => path.join(dataDir, 'tasks', `${date}.json`);
const ITEMS = [
  { dedupeKey: 'interview:f:1', text: 'Drill the per-copy variant', content: 'From your coding round.' },
  { dedupeKey: 'interview:f:2', text: 'Confirm the next round', due: '2026-10-09' },
];

test('upsertTasks returns empty rejected lists for empty, added, and existing batches', (t) => {
  const { dataDir } = tempEnv(t);
  assert.deepEqual(upsertTasks(dataDir, [], { now }), { added: [], existing: [], rejected: [] });
  assert.deepEqual(upsertTasks(dataDir, [ITEMS[0]], { now }), {
    added: ['interview:f:1'], existing: [], rejected: [],
  });
  assert.deepEqual(upsertTasks(dataDir, [ITEMS[0]], { now }), {
    added: [], existing: ['interview:f:1'], rejected: [],
  });
});

test('creates today and due-date files with the task schema', (t) => {
  const { dataDir } = tempEnv(t);
  assert.deepEqual(upsertTasks(dataDir, ITEMS, { now }), { added: ['interview:f:1', 'interview:f:2'], existing: [], rejected: [] });
  assert.deepEqual(readJson(file(dataDir, '2026-10-05')), { date: '2026-10-05', tasks: [
    { text: 'Drill the per-copy variant', category: 'application', completed: false, content: 'From your coding round.', dedupeKey: 'interview:f:1', source: 'interview' },
  ] });
  assert.equal(readJson(file(dataDir, '2026-10-09')).tasks[0].dedupeKey, 'interview:f:2');
});

test('past, invalid, and malformed due dates fall back to today', (t) => {
  const { dataDir } = tempEnv(t);
  upsertTasks(dataDir, [
    { dedupeKey: 'k1', text: 'a', due: '2026-09-24' },
    { dedupeKey: 'k2', text: 'b', due: 'next week' },
    { dedupeKey: 'k3', text: 'c', due: '2026-02-30' },
  ], { now });
  assert.deepEqual(readJson(file(dataDir, '2026-10-05')).tasks.map((t) => t.dedupeKey), ['k1', 'k2', 'k3']);
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate('2026-02-30'), false);
});

test('dedupes across all task files and never touches an existing task', (t) => {
  const { dataDir } = tempEnv(t);
  upsertTasks(dataDir, ITEMS, { now });
  const today = readJson(file(dataDir, '2026-10-05'));
  today.tasks[0].completed = true;
  fs.writeFileSync(file(dataDir, '2026-10-05'), JSON.stringify(today));
  const later = pinned('2026-10-07T09:00:00');
  assert.deepEqual(upsertTasks(dataDir, ITEMS, { now: later }), { added: [], existing: ['interview:f:1', 'interview:f:2'], rejected: [] });
  assert.equal(fs.existsSync(file(dataDir, '2026-10-07')), false);
  assert.equal(readJson(file(dataDir, '2026-10-05')).tasks[0].completed, true);
});

test('appends to an existing daily file and keeps its tasks', (t) => {
  const { dataDir } = tempEnv(t);
  fs.mkdirSync(path.join(dataDir, 'tasks'));
  fs.writeFileSync(file(dataDir, '2026-10-05'), JSON.stringify({ date: '2026-10-05', tasks: [{ text: 'Solve LRU', category: 'coding', completed: false }] }));
  upsertTasks(dataDir, [ITEMS[0]], { now });
  assert.deepEqual(readJson(file(dataDir, '2026-10-05')).tasks.map((t) => t.text), ['Solve LRU', 'Drill the per-copy variant']);
});

test('a corrupt daily file is never overwritten', (t) => {
  const { dataDir } = tempEnv(t);
  fs.mkdirSync(path.join(dataDir, 'tasks'));
  fs.writeFileSync(file(dataDir, '2026-10-05'), '{broken');
  assert.throws(() => upsertTasks(dataDir, [ITEMS[0]], { now }), /not valid JSON/);
  assert.equal(fs.readFileSync(file(dataDir, '2026-10-05'), 'utf-8'), '{broken');
});

test('missingTaskKeys reports keys whose task disappeared', (t) => {
  const { dataDir } = tempEnv(t);
  upsertTasks(dataDir, ITEMS, { now });
  assert.deepEqual(missingTaskKeys(dataDir, ['interview:f:1', 'interview:f:2']), []);
  fs.rmSync(file(dataDir, '2026-10-05'));
  assert.deepEqual(missingTaskKeys(dataDir, ['interview:f:1', 'interview:f:2']), ['interview:f:1']);
});

function tempEnv(t) {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  return env;
}

test('preserves unknown daily and task fields and does not rewrite deduped files', (t) => {
  const { dataDir } = tempEnv(t);
  fs.mkdirSync(path.join(dataDir, 'tasks'));
  const original = { date: '2026-10-05', metadata: { agent: 'intel' }, tasks: [
    { text: 'Existing', completed: true, custom: { keep: [1, 2] }, dedupeKey: 'old' },
    null,
  ] };
  fs.writeFileSync(file(dataDir, '2026-10-05'), JSON.stringify(original));
  upsertTasks(dataDir, [ITEMS[0]], { now });
  const written = readJson(file(dataDir, '2026-10-05'));
  assert.deepEqual(written.metadata, original.metadata);
  assert.deepEqual(written.tasks.slice(0, 2), original.tasks);
  const before = fs.readFileSync(file(dataDir, '2026-10-05'), 'utf8');
  upsertTasks(dataDir, [{ ...ITEMS[0], text: 'Changed', content: 'Changed' }], { now });
  assert.equal(fs.readFileSync(file(dataDir, '2026-10-05'), 'utf8'), before);
});

test('dedupes across every parseable JSON task file regardless of filename date', (t) => {
  const { dataDir } = tempEnv(t);
  assert.deepEqual(missingTaskKeys(dataDir, ['absent']), ['absent']);
  fs.mkdirSync(path.join(dataDir, 'tasks'));
  for (const [name, contents] of Object.entries({
    '2025-01-01.json': JSON.stringify({ tasks: [{ dedupeKey: 'old' }] }),
    '2027-01-01.json': JSON.stringify({ tasks: [{ dedupeKey: 'future' }] }),
    '2026-10-01.json': '{broken',
    '2026-10-02.json': JSON.stringify({ tasks: {} }),
    '2026-10-03.json': 'null',
    'notes.json': JSON.stringify({ tasks: [{ dedupeKey: 'notes' }] }),
    '2026-02-30.json': JSON.stringify({ tasks: [{ dedupeKey: 'invalid-date' }] }),
    'notes.txt': JSON.stringify({ tasks: [{ dedupeKey: 'text-file' }] }),
  })) fs.writeFileSync(path.join(dataDir, 'tasks', name), contents);
  assert.deepEqual(missingTaskKeys(dataDir, ['old', 'future', 'notes', 'invalid-date', 'text-file']), ['text-file']);
  assert.deepEqual(upsertTasks(dataDir, [
    ...['old', 'future', 'notes', 'invalid-date'].map((dedupeKey) => ({ dedupeKey, text: 'Existing' })), ITEMS[0],
  ], { now }), { added: ['interview:f:1'], existing: ['old', 'future', 'notes', 'invalid-date'], rejected: [] });
  assert.equal(fs.readFileSync(file(dataDir, '2026-10-01'), 'utf8'), '{broken');
});

test('rejects tasks without dedupeKey without writing keyless tasks', (t) => {
  const { dataDir } = tempEnv(t);
  const items = [{ text: 'Missing' }, { dedupeKey: '', text: 'Empty' }, { dedupeKey: null, text: 'Null' }];
  const rejected = items.map((item) => ({ item, reason: 'missing dedupeKey' }));
  assert.deepEqual(upsertTasks(dataDir, items, { now }), { added: [], existing: [], rejected });
  assert.equal(fs.existsSync(path.join(dataDir, 'tasks')), false);
  assert.deepEqual(upsertTasks(dataDir, [...items, ITEMS[0]], { now }), {
    added: ['interview:f:1'], existing: [], rejected,
  });
  assert.deepEqual(readJson(file(dataDir, '2026-10-05')).tasks.map((task) => task.dedupeKey), ['interview:f:1']);
});

test('dedupes a batch, defaults content, and reads the injected clock once', (t) => {
  const { dataDir } = tempEnv(t);
  let reads = 0;
  assert.deepEqual(upsertTasks(dataDir, [
    { dedupeKey: 'same', text: 'First', due: '2026-10-05' },
    { dedupeKey: 'same', text: 'Second', due: '2026-10-09' },
  ], { now: () => { reads++; return now(); } }), { added: ['same'], existing: ['same'], rejected: [] });
  assert.equal(reads, 1);
  assert.deepEqual(readJson(file(dataDir, '2026-10-05')).tasks, [
    { text: 'First', category: 'application', completed: false, content: '', dedupeKey: 'same', source: 'interview' },
  ]);
  assert.equal(fs.existsSync(file(dataDir, '2026-10-09')), false);
});

test('validates real calendar dates and requires a YYYY-MM-DD string', () => {
  for (const value of ['2024-02-29', '2000-02-29', '0099-01-01']) assert.equal(isValidDate(value), true, value);
  for (const value of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-01', '2026-01-01T00:00:00', '', null, undefined, 20261005, { toString: () => '2026-10-05' }]) {
    assert.equal(isValidDate(value), false, String(value));
  }
});

test('a corrupt future destination names the file and remains untouched', (t) => {
  const { dataDir } = tempEnv(t);
  fs.mkdirSync(path.join(dataDir, 'tasks'));
  const dest = file(dataDir, '2026-10-09');
  fs.writeFileSync(dest, '{broken');
  assert.throws(() => upsertTasks(dataDir, [ITEMS[1]], { now }), (error) => {
    assert.match(error.message, /not valid JSON/);
    assert.ok(error.message.includes(dest));
    return true;
  });
  assert.equal(fs.readFileSync(dest, 'utf8'), '{broken');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['2026-10-09.json']);
});

test('valid JSON with an incompatible task shape is not discarded', (t) => {
  const { dataDir } = tempEnv(t);
  fs.mkdirSync(path.join(dataDir, 'tasks'));
  const dest = file(dataDir, '2026-10-05');
  for (const contents of ['null', '[]', '{"tasks":{"keep":true}}']) {
    fs.writeFileSync(dest, contents);
    assert.throws(() => upsertTasks(dataDir, [ITEMS[0]], { now }), /invalid task schema/);
    assert.equal(fs.readFileSync(dest, 'utf8'), contents);
  }
});

test('atomic replacement uses unique temp paths and cleans up a failed rename', (t) => {
  const { dataDir } = tempEnv(t);
  upsertTasks(dataDir, [ITEMS[0]], { now });
  const dest = file(dataDir, '2026-10-05');
  const before = fs.readFileSync(dest, 'utf8');
  const temps = [];
  t.mock.method(fs, 'renameSync', (temp, target) => {
    assert.equal(target, dest);
    assert.equal(path.dirname(temp), path.dirname(dest));
    assert.notEqual(temp, `${dest}.tmp`);
    assert.equal(readJson(temp).tasks.length, 2);
    temps.push(temp);
    throw new Error('simulated rename failure');
  });
  for (let i = 0; i < 2; i++) {
    assert.throws(() => upsertTasks(dataDir, [{ dedupeKey: 'new', text: 'New' }], { now }), /simulated rename failure/);
    assert.equal(fs.readFileSync(dest, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['2026-10-05.json']);
  }
  assert.notEqual(temps[0], temps[1]);
});
