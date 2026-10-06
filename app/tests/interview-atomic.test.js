const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv } = require('./helpers/interview-env');
const { MARKER_MD } = require('../lib/interview/contract');
const { writeOwned } = require('../lib/interview/markers');
const { writeRecord } = require('../lib/interview/records');
const { writeTracker } = require('../lib/interview/tracker-effects');
const { upsertTasks } = require('../lib/interview/task-effects');

function tempEnv(t) {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  return env;
}

for (const [name, write] of Object.entries({
  markers: (dataDir) => writeOwned(path.join(dataDir, 'notes.md'), `${MARKER_MD}\nNotes`),
  records: (dataDir) => writeRecord(dataDir, { folder: 'f1', status: 'unlinked' }),
  tracker: (dataDir) => writeTracker(dataDir, { 'Acme|SWE': { notes: 'Keep' } }),
  tasks: (dataDir) => upsertTasks(dataDir, [{ dedupeKey: 'k1', text: 'Follow up' }]),
})) {
  test(`${name} atomic write preserves its primary error if temporary cleanup also fails`, (t) => {
    const { dataDir } = tempEnv(t);
    const primary = new Error('rename failed');
    const cleanup = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    let attemptedCleanup = false;
    t.mock.method(fs, 'renameSync', () => { throw primary; });
    t.mock.method(fs, 'unlinkSync', (file) => {
      assert.ok(file.endsWith('.tmp'));
      attemptedCleanup = true;
      throw cleanup;
    });
    assert.throws(() => write(dataDir), (error) => error === primary);
    assert.equal(attemptedCleanup, true);
  });
}

test('shared atomic writer creates parent directories and uses unique pid sibling temps for JSON and text', (t) => {
  const { writeFileAtomic } = require('../lib/interview/atomic');
  const { dataDir } = tempEnv(t);
  const file = path.join(dataDir, 'nested', 'artifact');
  const rename = fs.renameSync;
  const temps = [];
  t.mock.method(fs, 'renameSync', (temp, dest) => {
    assert.equal(dest, file);
    assert.equal(path.dirname(temp), path.dirname(file));
    assert.ok(temp.includes(`.${process.pid}.`));
    assert.ok(temp.endsWith('.tmp'));
    temps.push(temp);
    rename(temp, dest);
  });
  for (const data of ['{"value":1}', 'Plain text\n']) {
    writeFileAtomic(file, data);
    assert.equal(fs.readFileSync(file, 'utf8'), data);
  }
  assert.equal(new Set(temps).size, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['artifact']);
});
