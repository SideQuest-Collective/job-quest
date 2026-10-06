const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SETTLE_MS, eligibleFolders, scanOnce, startScanner } = require('../lib/interview/scanner');
const records = require('../lib/interview/records');
const {
  makeEnv, copyFixtureSession, setSessionFields, seedRole, installFakeAnalyst, withFakeAgent,
  FIXTURE_DIR, FIXTURE_FOLDER, ROLE_KEY, pinned,
} = require('./helpers/interview-env');

const SKELETON = '# Debrief\n\nRound: coding\n\n## Scorecard\n\n_(filled in by the /interview skill on stop)_\n';
const now = pinned('2026-10-05T12:00:00.000Z');
const ago = (file, ms) => {
  const time = new Date(now().getTime() - ms);
  fs.utimesSync(file, time, time);
};

function setup(t) {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  return env;
}

test('eligibleFolders needs session.json and debrief.md and waits for a fresh skeleton debrief', (t) => {
  const { interviewHome } = setup(t);
  const s = (name) => copyFixtureSession(interviewHome, name);
  s('2026-03-14_0930');
  fs.rmSync(path.join(s('2026-09-22_0900'), 'debrief.md'));
  fs.rmSync(path.join(s('2026-09-23_0900'), 'session.json'));
  const fresh = path.join(s('2026-09-24_0900'), 'debrief.md');
  fs.writeFileSync(fresh, SKELETON);
  ago(fresh, 0);
  const old = path.join(s('2026-09-25_0900'), 'debrief.md');
  fs.writeFileSync(old, SKELETON);
  ago(old, 2 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(interviewHome, 'sessions', 'notes.txt'), 'not a folder');
  fs.mkdirSync(path.join(interviewHome, 'live'), { recursive: true });
  for (const name of ['session.json', 'debrief.md']) {
    fs.copyFileSync(path.join(FIXTURE_DIR, FIXTURE_FOLDER, name), path.join(interviewHome, 'live', name));
  }
  assert.equal(SETTLE_MS, 30 * 60 * 1000);
  assert.deepEqual(eligibleFolders(interviewHome, { now }), ['2026-03-14_0930', '2026-09-25_0900']);
  assert.deepEqual(eligibleFolders(path.join(interviewHome, 'missing'), { now }), []);
});

test('skips a fresh skeleton debrief, ingests it once settled', async (t) => {
  withFakeAgent(t);
  const { dataDir, interviewHome } = setup(t);
  seedRole(dataDir);
  const dir = copyFixtureSession(interviewHome);
  setSessionFields(dir, { roleKey: ROLE_KEY });
  installFakeAnalyst(dataDir);
  const realDebrief = fs.readFileSync(path.join(dir, 'debrief.md'), 'utf-8');
  fs.writeFileSync(path.join(dir, 'debrief.md'), SKELETON);
  ago(path.join(dir, 'debrief.md'), 0);
  assert.deepEqual(await scanOnce({ dataDir, interviewHome, now }), []);
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER), null);
  fs.writeFileSync(path.join(dir, 'debrief.md'), realDebrief);
  ago(path.join(dir, 'debrief.md'), 0);
  const lines = [];
  const scan = () => scanOnce({ dataDir, interviewHome, now, log: (m) => lines.push(m) });
  assert.deepEqual(await scan(), [{ folder: FIXTURE_FOLDER, status: 'ingested' }]);
  assert.deepEqual(await scan(), [{ folder: FIXTURE_FOLDER, status: 'unchanged' }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[interview\] Ingested /);
});

test('scanOnce reports a bad folder and keeps going', async (t) => {
  withFakeAgent(t);
  const { dataDir, interviewHome } = setup(t);
  const bad = copyFixtureSession(interviewHome, '2026-03-13_0800');
  setSessionFields(bad, { contractVersion: 'jq-interview/2' });
  copyFixtureSession(interviewHome);
  const lines = [];
  const results = await scanOnce({ dataDir, interviewHome, now, log: (m) => lines.push(m) });
  assert.equal(results.length, 2);
  assert.equal(results[0].folder, '2026-03-13_0800');
  assert.match(results[0].error, /contract mismatch/);
  assert.deepEqual(results[1], { folder: FIXTURE_FOLDER, status: 'unlinked' });
  assert.equal(lines.length, 1);
});

test('startScanner scans at startup, never overlaps, and logs a repeated error once', async (t) => {
  withFakeAgent(t);
  const { dataDir, interviewHome } = setup(t);
  setSessionFields(copyFixtureSession(interviewHome, '2026-03-13_0800'), { contractVersion: 'jq-interview/2' });
  copyFixtureSession(interviewHome);
  const lines = [];
  const scanner = startScanner({ dataDir, interviewHome, now, intervalMs: 60 * 60 * 1000, log: (m) => lines.push(m) });
  let pending;
  try {
    assert.equal(scanner.isRunning(), true);
    pending = scanner.runNow();
    assert.equal(scanner.runNow(), pending);
    await pending;
    assert.equal(scanner.isRunning(), false);
    assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).status, 'unlinked');
    pending = scanner.runNow();
    await pending;
    assert.equal(lines.filter((l) => /contract mismatch/.test(l)).length, 1);
  } finally {
    scanner.stop();
    await pending;
  }
});

test('skeleton settling uses the injected clock, exact boundary, and settleMs override', async (t) => {
  const { dataDir, interviewHome } = setup(t);
  const debrief = path.join(copyFixtureSession(interviewHome), 'debrief.md');
  fs.writeFileSync(debrief, SKELETON);
  ago(debrief, SETTLE_MS - 1);
  assert.deepEqual(eligibleFolders(interviewHome, { now }), []);
  ago(debrief, SETTLE_MS);
  assert.deepEqual(eligibleFolders(interviewHome, { now }), [FIXTURE_FOLDER]);
  assert.deepEqual(await scanOnce({ dataDir, interviewHome, now }), [{ folder: FIXTURE_FOLDER, status: 'unlinked' }]);
  ago(debrief, 999);
  assert.deepEqual(eligibleFolders(interviewHome, { now, settleMs: 1000 }), []);
  ago(debrief, 1000);
  assert.deepEqual(eligibleFolders(interviewHome, { now, settleMs: 1000 }), [FIXTURE_FOLDER]);
});

test('invalid names and escaping or broken symlinks are skipped without reading live', (t) => {
  const { interviewHome } = setup(t);
  const root = path.join(interviewHome, 'sessions');
  const dir = copyFixtureSession(interviewHome);
  for (const name of ['bad name', 'bad..name', '.hidden']) copyFixtureSession(interviewHome, name);
  const live = path.join(interviewHome, 'live');
  const outside = path.join(interviewHome, 'sessions-outside');
  fs.cpSync(dir, live, { recursive: true });
  fs.cpSync(dir, outside, { recursive: true });
  fs.symlinkSync(dir, path.join(root, 'inside'));
  fs.symlinkSync(live, path.join(root, 'live-link'));
  fs.symlinkSync(outside, path.join(root, 'outside-link'));
  fs.symlinkSync(path.join(interviewHome, 'missing'), path.join(root, 'broken'));
  const read = fs.readFileSync;
  const reads = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    reads.push(fs.realpathSync(file));
    return read(file, ...args);
  });
  assert.deepEqual(eligibleFolders(interviewHome, { now }), [FIXTURE_FOLDER, 'inside']);
  assert.ok(reads.every((file) => file.startsWith(fs.realpathSync(root) + path.sep)));
});

test('a busy folder is reported without waiting and retried on the next pass', async (t) => {
  const { dataDir, interviewHome } = setup(t);
  copyFixtureSession(interviewHome);
  copyFixtureSession(interviewHome, '2026-09-22_0900');
  const lines = [];
  await records.withLock(dataDir, FIXTURE_FOLDER, async () => {
    const results = await scanOnce({ dataDir, interviewHome, now, log: (m) => lines.push(m) });
    assert.match(results[0].error, /^busy: another ingest/);
    assert.deepEqual(results[1], { folder: '2026-09-22_0900', status: 'unlinked' });
    assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER), null);
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(await scanOnce({ dataDir, interviewHome, now }), [
    { folder: FIXTURE_FOLDER, status: 'unlinked' },
    { folder: '2026-09-22_0900', status: 'unlinked' },
  ]);
});

test('every record status is revisited, including failed and stale ingesting records', async (t) => {
  withFakeAgent(t);
  const { dataDir, interviewHome } = setup(t);
  seedRole(dataDir);
  setSessionFields(copyFixtureSession(interviewHome), { roleKey: ROLE_KEY });
  installFakeAnalyst(dataDir);
  const scan = () => scanOnce({ dataDir, interviewHome, now });
  await scan();
  const record = records.readRecord(dataDir, FIXTURE_FOLDER);
  for (const status of ['unlinked', 'linking', 'failed', 'ingesting', 'ingested']) {
    records.writeRecord(dataDir, { ...record, status });
    // An ingested record must also be revisited to repair clobbered effects.
    seedRole(dataDir);
    const lock = path.join(records.recordsDir(dataDir), `.${FIXTURE_FOLDER}.lock`);
    if (status === 'ingesting') {
      fs.writeFileSync(lock, 'stale-owner');
      fs.utimesSync(lock, new Date(0), new Date(0));
    }
    assert.deepEqual(await scan(), [{ folder: FIXTURE_FOLDER, status: 'ingested' }], status);
    assert.equal(fs.existsSync(lock), false);
  }
  assert.deepEqual(await scan(), [{ folder: FIXTURE_FOLDER, status: 'unchanged' }]);
});

test('scanner timer is unrefd, scans sequentially, and stop clears it while in-flight work is awaited', async (t) => {
  const { dataDir, interviewHome } = setup(t);
  seedRole(dataDir);
  const second = '2026-09-22_0900';
  for (const folder of [FIXTURE_FOLDER, second]) {
    setSessionFields(copyFixtureSession(interviewHome, folder), { roleKey: ROLE_KEY });
  }
  let tick;
  let unrefs = 0;
  let clears = 0;
  const timer = { unref: () => { unrefs++; } };
  t.mock.method(global, 'setInterval', (fn, ms) => {
    assert.equal(ms, 600000);
    tick = fn;
    return timer;
  });
  t.mock.method(global, 'clearInterval', (handle) => {
    assert.equal(handle, timer);
    clears++;
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const runAgentFn = async ({ cwd, prompt }) => {
    calls.push(path.basename(cwd));
    await gate;
    await require('./fixtures/interview/fake-analyst')({ cwd, fs, path, prompt, attempt: 1 });
    return { ok: true };
  };
  const scanner = startScanner({ dataDir, interviewHome, now, runAgentFn, log: () => {} });
  const pending = scanner.runNow();
  try {
    assert.equal(unrefs, 1);
    assert.deepEqual(calls, [FIXTURE_FOLDER]);
    assert.equal(tick(), pending);
    assert.equal(scanner.runNow(), pending);
    scanner.stop();
    assert.equal(clears, 1);
    assert.equal(scanner.isRunning(), true);
    release();
    await pending;
    assert.deepEqual(calls, [FIXTURE_FOLDER, second]);
    assert.equal(scanner.isRunning(), false);
    // Simulate another timer pass: unchanged sessions do not rerun analysis.
    await tick();
    assert.deepEqual(calls, [FIXTURE_FOLDER, second]);
  } finally {
    scanner.stop();
    release();
    await pending;
  }
});
