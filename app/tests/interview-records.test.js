// app/tests/interview-records.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const records = require('../lib/interview/records');
const { makeEnv, copyFixtureSession } = require('./helpers/interview-env');

test('sessionHash is sha256(session.json + debrief.md) and tracks edits to either', () => {
  const { interviewHome } = makeEnv();
  const dir = copyFixtureSession(interviewHome);
  const expected = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(dir, 'session.json')))
    .update(fs.readFileSync(path.join(dir, 'debrief.md')))
    .digest('hex');
  assert.equal(records.sessionHash(dir), expected);
  assert.equal(records.sessionHash(dir), expected);
  fs.appendFileSync(path.join(dir, 'debrief.md'), '\nEdited.\n');
  const h2 = records.sessionHash(dir);
  assert.notEqual(h2, expected);
  fs.appendFileSync(path.join(dir, 'transcript.md'), 'not hashed\n');
  assert.equal(records.sessionHash(dir), h2);
});

test('records round-trip and list newest folder first, ignoring temp and lock files', () => {
  const { dataDir } = makeEnv();
  records.writeRecord(dataDir, { folder: '2026-03-07_1030', status: 'unlinked' });
  records.writeRecord(dataDir, { folder: '2026-03-14_0930', status: 'ingested' });
  fs.writeFileSync(path.join(records.recordsDir(dataDir), 'junk.json.tmp'), '{');
  fs.writeFileSync(path.join(records.recordsDir(dataDir), '.2026-03-14_0930.lock'), '1');
  assert.deepEqual(records.listRecords(dataDir).map((r) => r.folder), ['2026-03-14_0930', '2026-03-07_1030']);
  assert.equal(records.readRecord(dataDir, '2026-03-14_0930').status, 'ingested');
  assert.equal(records.readRecord(dataDir, '2026-01-01_0000'), null);
  assert.throws(() => records.readRecord(dataDir, '../x'), (e) => e.code === 'INPUT');
});

test('withLock serializes callers on the same folder', async () => {
  const { dataDir } = makeEnv();
  const order = [];
  const slow = records.withLock(dataDir, 'f1', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 150)); order.push('a-end'); });
  await new Promise((r) => setTimeout(r, 20));
  const fast = records.withLock(dataDir, 'f1', async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('withLock with waitMs 0 reports busy; a stale lock is broken', async () => {
  const { dataDir } = makeEnv();
  let release;
  const held = records.withLock(dataDir, 'f2', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(records.withLock(dataDir, 'f2', async () => 1, { waitMs: 0 }), /busy: another ingest of f2 is running/);
  release();
  await held;
  const lock = path.join(records.recordsDir(dataDir), '.f3.lock');
  fs.writeFileSync(lock, '999999');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(await records.withLock(dataDir, 'f3', async () => 'ran', { waitMs: 0 }), 'ran');
  assert.equal(fs.existsSync(lock), false);
});

function tempEnv(t) {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  return env;
}

test('sessionHash tracks session edits and missing files contribute no bytes', (t) => {
  const { interviewHome } = tempEnv(t);
  const dir = copyFixtureSession(interviewHome);
  const before = records.sessionHash(dir);
  fs.appendFileSync(path.join(dir, 'session.json'), '\n');
  assert.notEqual(records.sessionHash(dir), before);
  fs.unlinkSync(path.join(dir, 'session.json'));
  assert.equal(records.sessionHash(dir), crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(dir, 'debrief.md'))).digest('hex'));
  fs.unlinkSync(path.join(dir, 'debrief.md'));
  assert.equal(records.sessionHash(dir), crypto.createHash('sha256').digest('hex'));
});

test('records preserve bookkeeping, skip corrupt files, and use code-unit order', (t) => {
  const { dataDir } = tempEnv(t);
  assert.deepEqual(records.listRecords(dataDir), []);
  assert.equal(records.recordsDir(dataDir), path.join(dataDir, 'interview-sessions'));
  const record = {
    folder: 'fZ', hash: 'abc', roleKey: 'Acme|Engineer', round: 'coding', practice: false,
    startedAt: '2026-03-14T14:30:00.000Z', durationMin: 45, interviewer: 'Alex',
    questions: [], phases: [], scorecard: {}, analysis: null,
    effects: { timeline: true, stage: false, workbookQids: [], tasks: [], progress: [] },
    ingestedAt: '2026-03-14T15:20:00.000Z', status: 'linking', link: null,
    contractVersion: 'jq-interview/1', workbookId: null, dropped: [],
    analysisError: null, analysisAttempts: 0, applied: false,
  };
  assert.equal(records.writeRecord(dataDir, record), record);
  assert.deepEqual(records.readRecord(dataDir, record.folder), record);
  records.writeRecord(dataDir, { folder: 'fa', status: 'unlinked' });
  fs.writeFileSync(path.join(records.recordsDir(dataDir), 'broken.json'), '{');
  assert.equal(records.readRecord(dataDir, 'broken'), null);
  assert.deepEqual(records.listRecords(dataDir).map((r) => r.folder), ['fa', 'fZ']);
});

test('writeRecord and withLock reject unsafe folders before creating directories', async (t) => {
  const { dataDir } = tempEnv(t);
  const unused = path.join(dataDir, 'unused');
  assert.throws(() => records.writeRecord(unused, { folder: '../escape' }), { code: 'INPUT' });
  await assert.rejects(records.withLock(unused, '../escape', () => assert.fail('called')), { code: 'INPUT' });
  assert.equal(fs.existsSync(unused), false);
});

test('atomic record writes preserve the previous record and clean up a failed rename', (t) => {
  const { dataDir } = tempEnv(t);
  const record = { folder: 'f1', status: 'unlinked' };
  records.writeRecord(dataDir, record);
  const dir = records.recordsDir(dataDir);
  const temps = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    temps.push(from);
    assert.equal(to, path.join(dir, 'f1.json'));
    assert.ok(path.basename(from).includes(`.${process.pid}.`));
    assert.equal(records.readRecord(dataDir, 'f1').status, 'unlinked');
    throw new Error('rename failed');
  });
  for (let i = 0; i < 2; i++) {
    assert.throws(() => records.writeRecord(dataDir, { ...record, status: 'ingested' }), /rename failed/);
    assert.deepEqual(fs.readdirSync(dir), ['f1.json']);
  }
  assert.notEqual(temps[0], temps[1]);
  assert.deepEqual(records.readRecord(dataDir, 'f1'), record);
});

test('atomic record writes clean up a partially written temporary file', (t) => {
  const { dataDir } = tempEnv(t);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    write(file, ...args);
    throw new Error('write failed');
  });
  assert.throws(() => records.writeRecord(dataDir, { folder: 'f1' }), /write failed/);
  assert.deepEqual(fs.readdirSync(records.recordsDir(dataDir)), []);
});

test('withLock returns results, releases on exceptions, and allows other folders', async (t) => {
  const { dataDir } = tempEnv(t);
  for (const fn of [() => { throw new Error('sync failure'); }, async () => { throw new Error('async failure'); }]) {
    await assert.rejects(records.withLock(dataDir, 'f1', fn), /failure/);
    assert.equal(fs.existsSync(path.join(records.recordsDir(dataDir), '.f1.lock')), false);
  }
  assert.equal(await records.withLock(dataDir, 'f1', () =>
    records.withLock(dataDir, 'f2', () => 42, { waitMs: 0 })), 42);
});

test('withLock does not release a replacement owners lock', async (t) => {
  const { dataDir } = tempEnv(t);
  const lock = path.join(records.recordsDir(dataDir), '.f1.lock');
  await records.withLock(dataDir, 'f1', () => {
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, 'replacement-owner');
  });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement-owner');
});

test('stale-lock reclamation rechecks ownership before removing the lock', async (t) => {
  const { dataDir } = tempEnv(t);
  fs.mkdirSync(records.recordsDir(dataDir));
  const lock = path.join(records.recordsDir(dataDir), '.f1.lock');
  const now = Date.now();
  const old = new Date(now - 3600000);
  fs.writeFileSync(lock, 'stale-owner');
  fs.utimesSync(lock, old, old);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const value = read(...args);
    if (++reads === 1) {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, 'replacement-owner');
      fs.utimesSync(lock, new Date(now), new Date(now));
    }
    return value;
  });
  await assert.rejects(records.withLock(dataDir, 'f1', () => assert.fail('called'), { waitMs: 0 }),
    /busy: another ingest of f1 is running/);
  assert.equal(read(lock, 'utf8'), 'replacement-owner');
});

test('withLock closes and removes the lock when writing its token fails', async (t) => {
  const { dataDir } = tempEnv(t);
  const lock = path.join(records.recordsDir(dataDir), '.f1.lock');
  const failure = new Error('token write failed');
  let descriptor;
  const write = t.mock.method(fs, 'writeFileSync', (fd) => {
    descriptor = fd;
    throw failure;
  });
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (file === lock) assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
    return unlink(file);
  });
  await assert.rejects(records.withLock(dataDir, 'f1', () => assert.fail('called')),
    (error) => error === failure);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  assert.equal(fs.existsSync(lock), false);
  write.mock.restore();
  assert.equal(await records.withLock(dataDir, 'f1', () => 42, { waitMs: 0 }), 42);
});

for (const releaseStep of ['read', 'recheck', 'unlink']) {
  for (const outcome of ['success', 'sync failure', 'async failure']) {
    test(`withLock preserves ${outcome} when release ${releaseStep} throws`, async (t) => {
      const { dataDir } = tempEnv(t);
      const lock = path.join(records.recordsDir(dataDir), '.f1.lock');
      const failure = new Error('callback failed');
      const releaseFailure = Object.assign(new Error('release failed'), { code: 'EACCES' });
      let injected = false;
      const result = records.withLock(dataDir, 'f1', () => {
        const method = releaseStep === 'unlink' ? 'unlinkSync' : 'openSync';
        const original = fs[method];
        let reads = 0;
        t.mock.method(fs, method, (file, ...args) => {
          if (file === lock && (method === 'unlinkSync' ||
              (args[0] === 'r' && ++reads === (releaseStep === 'recheck' ? 2 : 1)))) {
            injected = true;
            throw releaseFailure;
          }
          return original(file, ...args);
        });
        if (outcome === 'sync failure') throw failure;
        if (outcome === 'async failure') return Promise.reject(failure);
        return 42;
      });
      if (outcome === 'success') assert.equal(await result, 42);
      else await assert.rejects(result, (error) => error === failure);
      assert.equal(injected, true);
    });
  }
}

test('withLock reports busy after waitMs for a dangling-symlink lock without spinning', (t) => {
  const { dataDir } = tempEnv(t);
  fs.mkdirSync(records.recordsDir(dataDir));
  fs.symlinkSync(path.join(dataDir, 'missing'), path.join(records.recordsDir(dataDir), '.f1.lock'));
  // A child process bounds the regression even if the acquisition loop never yields.
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const records = require(${JSON.stringify(require.resolve('../lib/interview/records'))});
    assert.rejects(records.withLock(${JSON.stringify(dataDir)}, 'f1',
      () => assert.fail('called'), { waitMs: 50 }),
      { message: 'busy: another ingest of f1 is running' }
    ).catch((error) => { console.error(error); process.exitCode = 1; });
  `], { timeout: 10000, encoding: 'utf8' });
  assert.equal(child.error, undefined, child.error && child.error.message);
  assert.equal(child.status, 0, child.stderr);
});
