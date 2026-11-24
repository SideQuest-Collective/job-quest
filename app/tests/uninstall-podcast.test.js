// T-0031: uninstall.sh removes the Daily Drop podcast job (com.sidequest.job-quest.daily-podcast)
// along with the daily intel and trainer jobs, and never rewrites a crontab it could not read
// or that holds no podcast entry (a blind `crontab -l | grep -v ... | crontab -` would replace
// the user's crontab with an empty or partial one).
// Temporary HOME from tests/helpers/schedule-home.js: launchctl and crontab are logging stubs
// (the helper refuses to run scripts that name them by absolute path), claude is a no-op, and
// lsof, ps and rm are stubbed by the helper as in uninstall-script.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { LABELS, MARKERS, LINUX, scheduleHome, uninstallHome: fixtureHome, runUninstall } = require('./helpers/schedule-home');

const PODCAST = 'install-podcast-schedule.sh';
const LABEL = LABELS.podcast;
const MARKER = MARKERS.podcast;
const OTHER_CRON = '15 6 * * * /usr/local/bin/backup.sh';
const PODCAST_CRON = `30 8 * * * /bin/bash /x/run-daily-podcast.sh ${MARKER}`;
const darwinOnly = { skip: process.platform !== 'darwin' && 'launchd plists are macOS only' };

// helper: install-podcast-schedule.sh is present in ~/.job-quest/bin (otherwise uninstall.sh
// must fall back to removing the job itself). No other schedule script is installed.
function uninstallHome(t, { helper, plist = false, crontab = null, crontabFails = false }) {
  return fixtureHome(t, { helpers: helper ? [PODCAST] : [], plists: plist ? ['podcast'] : [], crontab, crontabFails });
}

function assertPodcastJobRemoved(f) {
  assert.equal(fs.existsSync(f.plistPath('podcast')), false, `${LABEL}.plist must be removed`);
  assert.ok(f.launchctlCalls().some(line => /^(unload|bootout)\b/.test(line) && line.includes(LABEL)),
    `the podcast job is unloaded; launchctl calls: ${JSON.stringify(f.launchctlCalls())}`);
}

for (const helper of [true, false]) {
  test(`uninstall unloads and removes the daily-podcast launchd job (${helper ? 'installed helper' : 'no helper, fallback'})`, darwinOnly, t => {
    const f = uninstallHome(t, { helper, plist: true });
    runUninstall(f);
    assertPodcastJobRemoved(f);
    assert.deepEqual(f.crontabWrites(), [], 'no crontab entry, so the crontab is not rewritten');
  });
}

test('uninstall fallback drops the daily-podcast crontab entry and keeps unrelated entries', t => {
  const f = uninstallHome(t, { helper: false, crontab: `${OTHER_CRON}\n${PODCAST_CRON}\n` });
  runUninstall(f);
  const after = f.crontabText();
  assert.ok(after !== null && !after.includes(MARKER), `podcast cron entry removed: ${JSON.stringify(after)}`);
  assert.ok(after.includes(OTHER_CRON), 'unrelated crontab entries are kept');
  assert.equal(f.crontabWrites().length, 1, `one crontab rewrite: ${JSON.stringify(f.crontabWrites())}`);
});

test('uninstall on Linux removes the daily-podcast crontab entry through the installed helper', t => {
  const f = uninstallHome(t, { helper: true, crontab: `${OTHER_CRON}\n${PODCAST_CRON}\n` });
  runUninstall(f, LINUX);
  const after = f.crontabText();
  assert.ok(after !== null && !after.includes(MARKER), `podcast cron entry removed: ${JSON.stringify(after)}`);
  assert.ok(after.includes(OTHER_CRON), 'unrelated crontab entries are kept');
});

// The next two also assert the launchd job is removed, so they fail until uninstall.sh
// handles the podcast job at all; the crontab assertions are the point.
test('uninstall fallback removes the launchd job but leaves the crontab alone when `crontab -l` fails', darwinOnly, t => {
  // `crontab -l` prints the entries, including the podcast one, and then exits 1.
  const crontab = `${OTHER_CRON}\n${PODCAST_CRON}\n`;
  const f = uninstallHome(t, { helper: false, plist: true, crontab, crontabFails: true });
  runUninstall(f);
  assertPodcastJobRemoved(f);
  assert.deepEqual(f.crontabWrites(), [], 'a crontab that could not be read is never rewritten');
  assert.equal(f.crontabText(), crontab, 'the crontab is unchanged');
});

test('uninstall fallback removes the launchd job and writes no crontab when there is no podcast entry', darwinOnly, t => {
  for (const crontab of [`${OTHER_CRON}\n`, '', null]) {
    const label = crontab === null ? 'the user has no crontab' : `crontab ${JSON.stringify(crontab)}`;
    const f = uninstallHome(t, { helper: false, plist: true, crontab });
    runUninstall(f);
    assertPodcastJobRemoved(f);
    assert.deepEqual(f.crontabWrites(), [], `${label}: nothing to remove, so no crontab rewrite`);
    assert.equal(f.crontabText(), crontab, `${label}: the crontab is unchanged`);
  }
});

// uninstall.sh runs this helper when it is installed, so its Linux (crontab) removal has
// to be just as careful. Runs on any host through OSTYPE=linux-gnu.
test('install-podcast-schedule.sh --uninstall on Linux removes only its own entry and never rewrites a crontab it could not read', t => {
  let f = scheduleHome(t, { scripts: [PODCAST] });
  f.writeCrontab(`${OTHER_CRON}\n${PODCAST_CRON}\n`);
  let result = f.runScript(PODCAST, ['--uninstall'], LINUX);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!f.crontabText().includes(MARKER), `podcast cron entry removed: ${JSON.stringify(f.crontabText())}`);
  assert.ok(f.crontabText().includes(OTHER_CRON), 'unrelated crontab entries are kept');
  assert.equal(f.crontabWrites().length, 1);

  // `crontab -l` prints the entries and then exits 1: not a listing to build a new crontab from.
  f = scheduleHome(t, { scripts: [PODCAST] });
  const crontab = `${OTHER_CRON}\n${PODCAST_CRON}\n`;
  f.writeCrontab(crontab);
  f.failCrontab();
  f.runScript(PODCAST, ['--uninstall'], LINUX);
  assert.deepEqual(f.crontabWrites(), [], 'a crontab that could not be read is never rewritten');
  assert.equal(f.crontabText(), crontab, 'the crontab is unchanged');

  for (const existing of [`${OTHER_CRON}\n`, '', null]) {
    const label = existing === null ? 'the user has no crontab' : `crontab ${JSON.stringify(existing)}`;
    f = scheduleHome(t, { scripts: [PODCAST] });
    if (existing !== null) f.writeCrontab(existing);
    result = f.runScript(PODCAST, ['--uninstall'], LINUX);
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(f.crontabWrites(), [], `${label}: nothing to remove, so no crontab rewrite`);
    assert.equal(f.crontabText(), existing, `${label}: the crontab is unchanged`);
  }
  assert.deepEqual(f.launchctlCalls(), [], 'the Linux branch never calls launchctl');
});
