// T-0031: install-schedule.sh and install-trainer-schedule.sh `--exists` on Linux read the
// crontab once. A failed `crontab -l` other than "no crontab for" is "could not tell"
// (exit 2), never "not installed", and output printed by a failed read never counts as
// installed. "no crontab for" is "not installed" (exit 1). The check never writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleHome, LINUX, MARKERS } = require('./helpers/schedule-home');

const OTHER_CRON = '15 6 * * * /usr/local/bin/backup.sh';
const ENTRIES = {
  intel: `3 7 * * 1-5 /x/run-daily-intel.sh ${MARKERS.intel}`,
  trainer: `0 9-21 * * * /x/run-interview-trainer.sh ${MARKERS.trainer}`,
};

function assertUntouched(f, before) {
  assert.deepEqual(f.crontabWrites(), [], '--exists must not rewrite the crontab');
  assert.equal(f.crontabText(), before, 'the crontab is unchanged');
  assert.deepEqual(f.launchctlCalls(), [], 'the Linux branch never calls launchctl');
  assert.deepEqual(f.agentFiles(), []);
  assert.deepEqual(f.tripwires(), []);
}

for (const [script, kind] of [['install-schedule.sh', 'intel'], ['install-trainer-schedule.sh', 'trainer']]) {
  test(`${script} --exists on Linux: 0 with the entry, 1 without or with no crontab`, t => {
    const f = scheduleHome(t);
    let result = f.runScript(script, ['--exists'], LINUX);
    assert.equal(result.status, 1, `no crontab: ${result.stdout}${result.stderr}`);
    assertUntouched(f, null);

    f.writeCrontab(`${OTHER_CRON}\n`);
    result = f.runScript(script, ['--exists'], LINUX);
    assert.equal(result.status, 1, `crontab without the entry: ${result.stdout}${result.stderr}`);

    const crontab = `${OTHER_CRON}\n${ENTRIES[kind]}\n`;
    f.writeCrontab(crontab);
    result = f.runScript(script, ['--exists'], LINUX);
    assert.equal(result.status, 0, `crontab with the entry: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '');
    assertUntouched(f, crontab);
  });

  test(`${script} --exists on Linux exits 2 when the crontab cannot be read`, t => {
    const f = scheduleHome(t);
    f.failCrontabAfter(0);
    const result = f.runScript(script, ['--exists'], LINUX);
    assert.equal(result.status, 2, `failed read without output: ${result.stdout}${result.stderr}`);
    assertUntouched(f, null);
  });

  test(`${script} --exists on Linux exits 2 when a failed read prints the marker`, t => {
    const f = scheduleHome(t);
    const crontab = `${OTHER_CRON}\n${ENTRIES[kind]}\n`;
    f.writeCrontab(crontab);
    f.failCrontab();
    const result = f.runScript(script, ['--exists'], LINUX);
    assert.equal(result.status, 2, `failed read with partial output: ${result.stdout}${result.stderr}`);
    assertUntouched(f, crontab);
  });
}
