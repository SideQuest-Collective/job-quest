// T-0031: Job Quest only rewrites the user's crontab from a listing it read successfully.
// The rule, for the Daily Drop Linux install and for uninstall.sh's daily intel and trainer
// fallbacks: run `crontab -l` once and keep its output and exit status; build the new
// crontab from that one listing, and only when it exited 0. A listing that failed is never
// rewritten. "no crontab for <user>" counts as an empty crontab only for an install, which
// may start from nothing; for a removal it means there is nothing to remove.
// Everything runs in a temporary HOME (tests/helpers/schedule-home.js): crontab and launchctl
// are logging stubs, and OSTYPE=linux-gnu selects the podcast script's crontab branch on any
// host. uninstall.sh's fallbacks are not platform-gated, so those tests need no OSTYPE.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { MARKERS, LINUX, scheduleHome, uninstallHome, runUninstall } = require('./helpers/schedule-home');

const INTEL = 'install-schedule.sh';
const TRAINER = 'install-trainer-schedule.sh';
const PODCAST = 'install-podcast-schedule.sh';
const OTHER_CRON = '15 6 * * * /usr/local/bin/backup.sh';
const OTHER_CRON_2 = '@reboot /usr/local/bin/start-proxy.sh # not a job-quest job';
const INTEL_CRON = `3 7 * * 1-5 /x/run-daily-intel.sh ${MARKERS.intel}`;
const TRAINER_CRON = `0 9-21 * * * /x/run-interview-trainer.sh ${MARKERS.trainer}`;
const REPLIES_CRON = `*/2 * * * * /x/run-trainer-replies.sh ${MARKERS.replies}`;
const PODCAST_CRON = `30 8 * * * /bin/bash /x/run-daily-podcast.sh ${MARKERS.podcast}`;

const describeCrontab = crontab => (crontab === null ? 'the user has no crontab' : `crontab ${JSON.stringify(crontab)}`);

// ---- install-podcast-schedule.sh [HH:MM] on Linux ----

function podcastHome(t, crontab) {
  const f = scheduleHome(t, { scripts: [PODCAST] });
  if (crontab !== null) f.writeCrontab(crontab);
  return f;
}

// The entry the script installs for 09:15: `15 9 * * * /bin/bash <bin>/run-daily-podcast.sh <marker>`.
function assertOneDailyDropEntry(f, label) {
  const entries = f.crontabLines().filter(line => line.includes(MARKERS.podcast));
  assert.equal(entries.length, 1, `${label}: exactly one Daily Drop entry: ${JSON.stringify(f.crontabLines())}`);
  assert.ok(entries[0].startsWith('15 9 * * * '), `${label}: the entry runs at 09:15: ${entries[0]}`);
  assert.ok(entries[0].includes(path.join(f.bin, 'run-daily-podcast.sh')), `${label}: the entry runs the installed runner: ${entries[0]}`);
}

test('install-podcast-schedule.sh on Linux adds its entry to what one successful crontab listing held', t => {
  // "no crontab for <user>" and an empty listing are both a legitimate place to start an
  // install from. A crontab that holds only an old Daily Drop entry ends up the same way.
  for (const crontab of [null, '', `${PODCAST_CRON}\n`]) {
    const label = describeCrontab(crontab);
    const f = podcastHome(t, crontab);
    const result = f.runScript(PODCAST, ['09:15'], LINUX);
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assertOneDailyDropEntry(f, label);
    assert.equal(f.crontabLines().length, 1, `${label}: the entry is the whole crontab: ${JSON.stringify(f.crontabLines())}`);
    assert.equal(f.crontabWrites().length, 1, `${label}: one crontab write: ${JSON.stringify(f.crontabWrites())}`);
    assert.match(result.stdout, /09:15/, `${label}: reports the time it scheduled`);
    assert.deepEqual(f.launchctlCalls(), [], 'the Linux branch never calls launchctl');
    assert.deepEqual(f.agentFiles(), [], 'the Linux branch never writes a launchd plist');
    assert.deepEqual(f.tripwires(), []);
  }

  // An existing crontab: the old entry is replaced and every other line is kept. The second
  // and later listings fail without output, so an install that checks one listing and builds
  // the new crontab from another would drop the unrelated lines here. (Today's one-pipeline
  // install already gets this part right; it is here so the rewrite cannot lose it.)
  const f = podcastHome(t, `${OTHER_CRON}\n${PODCAST_CRON}\n${OTHER_CRON_2}\n`);
  f.failCrontabAfter(1);
  const result = f.runScript(PODCAST, ['09:15'], LINUX);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertOneDailyDropEntry(f, 'existing crontab');
  assert.deepEqual(f.crontabLines().filter(line => !line.includes(MARKERS.podcast)), [OTHER_CRON, OTHER_CRON_2],
    'unrelated crontab lines are kept, in order');
  assert.equal(f.crontabWrites().length, 1, `one crontab write: ${JSON.stringify(f.crontabWrites())}`);
});

test('install-podcast-schedule.sh on Linux never builds a crontab from a listing that failed', t => {
  const cases = [
    // `crontab -l` prints the entries and then exits 1.
    ['a listing that prints entries and then fails', `${OTHER_CRON}\n${PODCAST_CRON}\n`, f => f.failCrontab()],
    // `crontab -l` prints nothing and exits 1, with an error that is not "no crontab for".
    ['a listing that fails without output', `${OTHER_CRON}\n${OTHER_CRON_2}\n`, f => f.failCrontabAfter(0)],
  ];
  for (const [label, crontab, breakListing] of cases) {
    const f = podcastHome(t, crontab);
    breakListing(f);
    const result = f.runScript(PODCAST, ['09:15'], LINUX);
    assert.deepEqual(f.crontabWrites(), [], `${label}: a crontab that could not be read is never rewritten`);
    assert.equal(f.crontabText(), crontab, `${label}: the crontab is unchanged`);
    assert.notEqual(result.status, 0, `${label}: nothing was scheduled, so the install must not exit 0`);
    assert.doesNotMatch(result.stdout, /scheduled/i, `${label}: must not report a schedule it did not install`);
    assert.match(result.stderr, /crontab/i, `${label}: says the crontab could not be read`);
    assert.deepEqual(f.launchctlCalls(), [], 'the Linux branch never calls launchctl');
  }
});

// ---- uninstall.sh fallbacks (the schedule script for that job is not installed) ----

// One fallback at a time: the other two jobs get a do-nothing helper in ~/.job-quest/bin,
// so the only crontab listing uninstall.sh makes belongs to the fallback under test.
// crontabFailsAfter: 1 then lets that fallback's first listing succeed and fails any later
// one without output, which is what a second `crontab -l` in the same fallback would hit.
function assertFallbackRemoves(t, { name, noopHelpers, entries }) {
  const crontab = `${OTHER_CRON}\n${entries.join('\n')}\n${OTHER_CRON_2}\n`;
  let f = uninstallHome(t, { noopHelpers, crontab, crontabFailsAfter: 1 });
  runUninstall(f);
  assert.deepEqual(f.crontabLines(), [OTHER_CRON, OTHER_CRON_2],
    `${name}: its entries are removed and every other line is kept, from the one listing that was read`);
  assert.equal(f.crontabWrites().length, 1, `${name}: one crontab write: ${JSON.stringify(f.crontabWrites())}`);

  // The cases below already hold for today's fallbacks. They are here so that the rewrite
  // to a single listing cannot lose them.
  // A crontab that holds nothing but this job's entries ends up empty, and the uninstall
  // still finishes (runUninstall checks that).
  f = uninstallHome(t, { noopHelpers, crontab: `${entries.join('\n')}\n` });
  runUninstall(f);
  assert.deepEqual(f.crontabLines(), [], `${name}: a crontab of only its own entries ends up empty`);

  // The listing prints the entries and then exits 1: nothing to build a new crontab from.
  f = uninstallHome(t, { noopHelpers, crontab, crontabFails: true });
  runUninstall(f);
  assert.deepEqual(f.crontabWrites(), [], `${name}: a crontab that could not be read is never rewritten`);
  assert.equal(f.crontabText(), crontab, `${name}: the crontab is unchanged`);

  // Nothing to remove (no entry, empty crontab, no crontab): no write, uninstall still finishes.
  for (const existing of [`${OTHER_CRON}\n`, '', null]) {
    f = uninstallHome(t, { noopHelpers, crontab: existing });
    runUninstall(f);
    assert.deepEqual(f.crontabWrites(), [], `${name}, ${describeCrontab(existing)}: no crontab rewrite`);
    assert.equal(f.crontabText(), existing, `${name}, ${describeCrontab(existing)}: the crontab is unchanged`);
  }
}

test('uninstall daily-intel fallback rewrites the crontab only from the one listing it read', t => {
  assertFallbackRemoves(t, { name: 'daily intel fallback', noopHelpers: [TRAINER, PODCAST], entries: [INTEL_CRON] });
});

test('uninstall trainer fallback rewrites the crontab only from the one listing it read', t => {
  assertFallbackRemoves(t, { name: 'trainer fallback', noopHelpers: [INTEL, PODCAST], entries: [TRAINER_CRON, REPLIES_CRON] });
});

test('uninstall with no schedule scripts installed removes every Job Quest job and keeps the rest of the crontab', t => {
  const crontab = `${OTHER_CRON}\n${INTEL_CRON}\n${TRAINER_CRON}\n${REPLIES_CRON}\n${PODCAST_CRON}\n${OTHER_CRON_2}\n`;
  let f = uninstallHome(t, { plists: ['intel', 'trainer', 'replies', 'podcast'], crontab });
  runUninstall(f);
  assert.deepEqual(f.crontabLines(), [OTHER_CRON, OTHER_CRON_2],
    'all four Job Quest crontab entries are removed and every other line is kept');
  assert.deepEqual(f.agentFiles(), [], 'all four launchd plists are removed');

  // A crontab of nothing but Job Quest entries ends up empty, and the uninstall still finishes.
  f = uninstallHome(t, { crontab: `${INTEL_CRON}\n${TRAINER_CRON}\n${REPLIES_CRON}\n${PODCAST_CRON}\n` });
  runUninstall(f);
  assert.deepEqual(f.crontabLines(), [], 'a crontab of only Job Quest entries ends up empty');

  // The first crontab again, but the listing prints it and then exits 1: no fallback may rewrite it.
  f = uninstallHome(t, { crontab, crontabFails: true });
  runUninstall(f);
  assert.deepEqual(f.crontabWrites(), [], 'a crontab that could not be read is never rewritten');
  assert.equal(f.crontabText(), crontab, 'the crontab is unchanged');
});
