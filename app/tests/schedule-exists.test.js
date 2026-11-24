// T-0031: `--exists` is the read-only status check behind the plugin's SessionStart
// hook and /job-quest:schedule. Contract for all three schedule scripts:
//   exit 0  the schedule is installed
//   exit 1  no schedule is installed
//   exit 2  the script could not tell (the Job Quest runtime failed to load, or, for the
//           podcast's crontab branch, the crontab could not be read)
// and the check never writes a plist, loads a launchd job or rewrites the crontab.
// Runs installed copies in a temporary HOME (tests/helpers/schedule-home.js), which also
// refuses to run a script that names launchctl or crontab by an absolute path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { scheduleHome, LINUX, MARKERS } = require('./helpers/schedule-home');

const darwinOnly = { skip: process.platform !== 'darwin' && 'launchd plists are macOS only' };
const PODCAST = 'install-podcast-schedule.sh';
const OTHER_CRON = '15 6 * * * /usr/local/bin/backup.sh';
const PODCAST_CRON = `30 8 * * * /bin/bash /x/run-daily-podcast.sh ${MARKERS.podcast}`;

function assertReadOnly(f, agentsBefore) {
  assert.deepEqual(f.agentFiles(), agentsBefore, '--exists must not create or remove launchd plists');
  assert.deepEqual(f.launchctlCalls().filter(c => /^(load|unload|bootstrap|bootout|enable|disable)\b/.test(c)), [],
    '--exists must not load or unload launchd jobs');
  assert.deepEqual(f.crontabWrites(), [], '--exists must not rewrite the crontab');
  assert.deepEqual(f.tripwires(), []);
}

for (const [script, kind] of [['install-schedule.sh', 'intel'], ['install-trainer-schedule.sh', 'trainer']]) {
  test(`${script} --exists exits 0 when installed, 1 when not, 2 when the runtime fails to load`, darwinOnly, t => {
    const f = scheduleHome(t);
    let result = f.runScript(script, ['--exists']);
    assert.equal(result.status, 1, `no schedule installed: ${result.stdout}${result.stderr}`);
    assertReadOnly(f, []);

    const plist = f.writePlist(kind);
    result = f.runScript(script, ['--exists']);
    assert.equal(result.status, 0, `schedule installed: ${result.stdout}${result.stderr}`);
    assert.ok(fs.existsSync(plist));
    assertReadOnly(f, f.agentFiles());

    // A runtime that cannot load is "could not tell", never "not installed".
    const broken = scheduleHome(t, { runtime: 'crash' });
    result = broken.runScript(script, ['--exists']);
    assert.equal(result.status, 2, `runtime load failure, no plist: ${result.stdout}${result.stderr}`);
    broken.writePlist(kind);
    result = broken.runScript(script, ['--exists']);
    assert.equal(result.status, 2, `runtime load failure, plist present: ${result.stdout}${result.stderr}`);
    assertReadOnly(broken, broken.agentFiles());
  });
}

test('install-podcast-schedule.sh --exists exits 0 when the Daily Drop job is installed, 1 when not, and writes nothing', darwinOnly, t => {
  const f = scheduleHome(t);
  let result = f.runScript(PODCAST, ['--exists']);
  assert.equal(result.status, 1, `no podcast schedule: ${result.stdout}${result.stderr}`);
  assertReadOnly(f, []);

  f.writePlist('podcast');
  const before = fs.readFileSync(f.plistPath('podcast'), 'utf8');
  result = f.runScript(PODCAST, ['--exists']);
  assert.equal(result.status, 0, `podcast schedule installed: ${result.stdout}${result.stderr}`);
  assert.equal(fs.readFileSync(f.plistPath('podcast'), 'utf8'), before, '--exists must not rewrite the plist');
  assertReadOnly(f, f.agentFiles());
});

// The Linux branch reads the crontab. These run on any host: OSTYPE=linux-gnu selects the
// branch and `crontab` is the fixture stub.
function assertCrontabUntouched(f, before) {
  assert.deepEqual(f.crontabWrites(), [], '--exists must not rewrite the crontab');
  assert.equal(f.crontabText(), before, 'the crontab is unchanged');
  assert.deepEqual(f.launchctlCalls(), [], 'the Linux branch never calls launchctl');
  assert.deepEqual(f.agentFiles(), [], '--exists must not create launchd plists');
  assert.deepEqual(f.tripwires(), []);
}

test('install-podcast-schedule.sh --exists on Linux exits 0 when the crontab holds the Daily Drop entry', t => {
  const f = scheduleHome(t);
  const crontab = `${OTHER_CRON}\n${PODCAST_CRON}\n`;
  f.writeCrontab(crontab);
  const result = f.runScript(PODCAST, ['--exists'], LINUX);
  assert.equal(result.status, 0, `crontab entry present: ${result.stdout}${result.stderr}`);
  assertCrontabUntouched(f, crontab);
});

test('install-podcast-schedule.sh --exists on Linux exits 1 when the crontab has no Daily Drop entry', t => {
  for (const crontab of [`${OTHER_CRON}\n`, '', null]) {
    const label = crontab === null ? 'the user has no crontab' : `crontab ${JSON.stringify(crontab)}`;
    const f = scheduleHome(t);
    if (crontab !== null) f.writeCrontab(crontab);
    const result = f.runScript(PODCAST, ['--exists'], LINUX);
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Time must look like/, `${label}: --exists is a status check, not a time to install`);
    assertCrontabUntouched(f, crontab);
  }
});

test('install-podcast-schedule.sh --exists on Linux exits 2 when the crontab cannot be read', t => {
  const f = scheduleHome(t);
  f.failCrontab();
  const result = f.runScript(PODCAST, ['--exists'], LINUX);
  assert.equal(result.status, 2, `a crontab read failure is "could not tell": ${result.stdout}${result.stderr}`);
  assertCrontabUntouched(f, null);
});
