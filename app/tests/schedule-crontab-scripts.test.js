// T-0031: install-schedule.sh (daily intel) and install-trainer-schedule.sh (trainer) rewrite
// the user's crontab only from a listing they read successfully. The rule is the one
// schedule-crontab.test.js checks for the Daily Drop script and uninstall.sh's fallbacks:
// run `crontab -l` once and keep its output, error text and exit status; build the new
// crontab from that one listing, and only when it exited 0. "no crontab for <user>" counts
// as an empty crontab for an install, which may start from nothing; for a removal it means
// there is nothing to remove. Any other failed listing is never rewritten: the script says
// so on stderr and exits non-zero. The one exception to the exit code is the cleanup of an
// old crontab entry after a launchd install on macOS: the schedule was installed, so the
// script still exits 0, and it leaves the crontab alone.
// Everything runs in a temporary HOME (tests/helpers/schedule-home.js): crontab and launchctl
// are logging stubs, OSTYPE=linux-gnu selects a script's crontab branch on any host, and the
// launchd tests run on macOS only. The last test is the static check that no Job Quest script
// pipes `crontab -l` into `crontab -`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, MARKERS, LINUX, scheduleHome, uninstallHome, runUninstall } = require('./helpers/schedule-home');

const INTEL = 'install-schedule.sh';
const TRAINER = 'install-trainer-schedule.sh';
const PODCAST = 'install-podcast-schedule.sh';
const RUNNERS = ['run-daily-intel.sh', 'run-interview-trainer.sh', 'run-trainer-replies.sh'];
const OTHER_CRON = '15 6 * * * /usr/local/bin/backup.sh';
const OTHER_CRON_2 = '@reboot /usr/local/bin/start-proxy.sh # not a job-quest job';
const INTEL_CRON = `3 7 * * 1-5 /x/run-daily-intel.sh ${MARKERS.intel}`;
const TRAINER_CRON = `0 9-21 * * * /x/run-interview-trainer.sh ${MARKERS.trainer}`;
const REPLIES_CRON = `*/2 * * * * /x/run-trainer-replies.sh ${MARKERS.replies}`;
// `--force-cron` takes install-schedule.sh's crontab branch on macOS. Forcing OSTYPE lets
// that case run on any host; the branch never touches launchd.
const DARWIN = { OSTYPE: 'darwin' };
const darwinOnly = { skip: process.platform !== 'darwin' && 'launchd plists are macOS only' };

const describeCrontab = crontab => (crontab === null ? 'the user has no crontab' : `crontab ${JSON.stringify(crontab)}`);
const isJobQuest = line => Object.values(MARKERS).some(marker => line.includes(marker));

// A `crontab -l` that cannot be trusted, in the two shapes a failure takes.
const BROKEN_LISTINGS = [
  // prints the entries and then exits 1
  ['a listing that prints entries and then fails', f => f.failCrontab()],
  // prints nothing and exits 1, with an error that is not "no crontab for <user>"
  ['a listing that fails without output', f => f.failCrontabAfter(0)],
];

// An installed copy of one schedule script, with the runners an install checks for.
function scriptHome(t, script, crontab = null) {
  const f = scheduleHome(t, { scripts: [script] });
  for (const runner of RUNNERS) fs.writeFileSync(path.join(f.bin, runner), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  if (crontab !== null) f.writeCrontab(crontab);
  return f;
}

function assertCrontabNotRewritten(f, crontab, label) {
  assert.deepEqual(f.crontabWrites(), [], `${label}: a crontab that could not be read is never rewritten`);
  assert.equal(f.crontabText(), crontab, `${label}: the crontab is unchanged`);
}

function assertReadFailureReported(result, label) {
  assert.notEqual(result.status, 0, `${label}: the crontab could not be read, so the script must not exit 0: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /crontab/i, `${label}: says the crontab could not be read`);
}

function assertNoLaunchd(f, label) {
  assert.deepEqual(f.launchctlCalls(), [], `${label}: the crontab branch never calls launchctl`);
  assert.deepEqual(f.agentFiles(), [], `${label}: the crontab branch never writes a launchd plist`);
}

// ---- install-schedule.sh "<cron>" on Linux, and --force-cron on macOS ----

// The entry the script installs for "15 9 * * *": `15 9 * * * <bin>/run-daily-intel.sh <marker>`.
function assertOneIntelEntry(f, label) {
  const entries = f.crontabLines().filter(line => line.includes(MARKERS.intel));
  assert.equal(entries.length, 1, `${label}: exactly one daily intel entry: ${JSON.stringify(f.crontabLines())}`);
  assert.ok(entries[0].startsWith('15 9 * * * '), `${label}: the entry carries the new schedule: ${entries[0]}`);
  assert.ok(entries[0].includes(path.join(f.bin, 'run-daily-intel.sh')), `${label}: the entry runs the installed runner: ${entries[0]}`);
}

test('install-schedule.sh cron install builds the crontab only from one successful listing', t => {
  const modes = [
    ['Linux', ['15 9 * * *'], LINUX],
    ['--force-cron on macOS', ['--force-cron', '15 9 * * *'], DARWIN],
  ];
  const crontab = `${OTHER_CRON}\n${INTEL_CRON}\n${OTHER_CRON_2}\n`;
  for (const [mode, args, env] of modes) {
    for (const [broken, breakListing] of BROKEN_LISTINGS) {
      const label = `${mode}, ${broken}`;
      const f = scriptHome(t, INTEL, crontab);
      breakListing(f);
      const result = f.runScript(INTEL, args, env);
      assertCrontabNotRewritten(f, crontab, label);
      assertReadFailureReported(result, label);
      assert.doesNotMatch(result.stdout, /Installed/i, `${label}: must not report a schedule it did not install`);
      assertNoLaunchd(f, label);
    }
  }

  // The cases below already hold today. They are here so the rewrite cannot lose them.
  // "no crontab for <user>", an empty listing and a crontab holding only an old daily intel
  // entry are all a legitimate place to start an install from.
  for (const [mode, args, env] of modes) {
    for (const existing of [null, '', `${INTEL_CRON}\n`]) {
      const label = `${mode}, ${describeCrontab(existing)}`;
      const f = scriptHome(t, INTEL, existing);
      const result = f.runScript(INTEL, args, env);
      assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
      assertOneIntelEntry(f, label);
      assert.equal(f.crontabLines().length, 1, `${label}: the entry is the whole crontab: ${JSON.stringify(f.crontabLines())}`);
      assert.equal(f.crontabWrites().length, 1, `${label}: one crontab write: ${JSON.stringify(f.crontabWrites())}`);
      assert.match(result.stdout, /15 9 \* \* \*/, `${label}: reports the entry it installed`);
      assertNoLaunchd(f, label);
      assert.deepEqual(f.tripwires(), []);
    }
  }

  // An existing crontab: the old entry is replaced and every other line is kept, from the
  // first listing. Every later listing fails without output.
  const f = scriptHome(t, INTEL, crontab);
  f.failCrontabAfter(1);
  const result = f.runScript(INTEL, ['15 9 * * *'], LINUX);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertOneIntelEntry(f, 'existing crontab');
  assert.deepEqual(f.crontabLines().filter(line => !line.includes(MARKERS.intel)), [OTHER_CRON, OTHER_CRON_2],
    'unrelated crontab lines are kept, in order');
  assert.equal(f.crontabWrites().length, 1, `one crontab write: ${JSON.stringify(f.crontabWrites())}`);
});

// ---- install-trainer-schedule.sh [start-end] on Linux ----

// The two entries the script installs for 8-20: `0 8-20 * * * <bin>/run-interview-trainer.sh <marker>`
// and the reply poller, `<schedule> <bin>/run-trainer-replies.sh <marker>`.
function assertTrainerEntries(f, label) {
  const trainer = f.crontabLines().filter(line => line.includes(MARKERS.trainer));
  const replies = f.crontabLines().filter(line => line.includes(MARKERS.replies));
  assert.equal(trainer.length, 1, `${label}: exactly one trainer entry: ${JSON.stringify(f.crontabLines())}`);
  assert.equal(replies.length, 1, `${label}: exactly one reply poller entry: ${JSON.stringify(f.crontabLines())}`);
  assert.ok(trainer[0].startsWith('0 8-20 * * * '), `${label}: the trainer entry carries the new hours: ${trainer[0]}`);
  assert.ok(trainer[0].includes(path.join(f.bin, 'run-interview-trainer.sh')), `${label}: the trainer entry runs the installed runner: ${trainer[0]}`);
  assert.ok(replies[0].includes(path.join(f.bin, 'run-trainer-replies.sh')), `${label}: the reply poller entry runs the installed runner: ${replies[0]}`);
}

test('install-trainer-schedule.sh cron install builds the crontab only from one successful listing', t => {
  const crontab = `${OTHER_CRON}\n${TRAINER_CRON}\n${REPLIES_CRON}\n${OTHER_CRON_2}\n`;
  for (const [label, breakListing] of BROKEN_LISTINGS) {
    const f = scriptHome(t, TRAINER, crontab);
    breakListing(f);
    const result = f.runScript(TRAINER, ['8-20'], LINUX);
    assertCrontabNotRewritten(f, crontab, label);
    assertReadFailureReported(result, label);
    assert.doesNotMatch(result.stdout, /Installed/i, `${label}: must not report a schedule it did not install`);
    assertNoLaunchd(f, label);
  }

  // The cases below already hold today. They are here so the rewrite cannot lose them.
  for (const existing of [null, '', `${TRAINER_CRON}\n${REPLIES_CRON}\n`, `${REPLIES_CRON}\n`]) {
    const label = describeCrontab(existing);
    const f = scriptHome(t, TRAINER, existing);
    const result = f.runScript(TRAINER, ['8-20'], LINUX);
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assertTrainerEntries(f, label);
    assert.equal(f.crontabLines().length, 2, `${label}: the two entries are the whole crontab: ${JSON.stringify(f.crontabLines())}`);
    assert.equal(f.crontabWrites().length, 1, `${label}: one crontab write: ${JSON.stringify(f.crontabWrites())}`);
    assert.match(result.stdout, /0 8-20 \* \* \*/, `${label}: reports the entries it installed`);
    assertNoLaunchd(f, label);
    assert.deepEqual(f.tripwires(), []);
  }

  const f = scriptHome(t, TRAINER, crontab);
  f.failCrontabAfter(1);
  const result = f.runScript(TRAINER, ['8-20'], LINUX);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertTrainerEntries(f, 'existing crontab');
  assert.deepEqual(f.crontabLines().filter(line => !isJobQuest(line)), [OTHER_CRON, OTHER_CRON_2],
    'unrelated crontab lines are kept, in order');
  assert.equal(f.crontabWrites().length, 1, `one crontab write: ${JSON.stringify(f.crontabWrites())}`);
});

// ---- --uninstall on Linux, both scripts ----

// entries: this script's crontab lines. The first case is the one that matters most: the
// listing that showed the entries is the listing the new crontab is built from, so a second
// `crontab -l` that fails or comes back empty cannot cost the user their other jobs.
function assertUninstallRemoves(t, { script, entries }) {
  const crontab = `${OTHER_CRON}\n${entries.join('\n')}\n${OTHER_CRON_2}\n`;
  let f = scriptHome(t, script, crontab);
  f.failCrontabAfter(1);
  let result = f.runScript(script, ['--uninstall'], LINUX);
  assert.deepEqual(f.crontabLines(), [OTHER_CRON, OTHER_CRON_2],
    `${script}: its entries are removed and every other line is kept, from the one listing that was read: ${result.stdout}${result.stderr}`);
  assert.equal(result.status, 0, `${script}: ${result.stdout}${result.stderr}`);
  assert.equal(f.crontabWrites().length, 1, `${script}: one crontab write: ${JSON.stringify(f.crontabWrites())}`);
  assert.match(result.stdout, /Removed/, `${script}: reports the removal`);
  assertNoLaunchd(f, script);

  // A crontab that holds nothing but this script's entries (the usual crontab of a Linux
  // user whose only cron job is Job Quest) ends up empty, and the script exits 0.
  for (const own of [entries, entries.slice(-1)]) {
    const label = `${script}, crontab of only ${JSON.stringify(own)}`;
    f = scriptHome(t, script, `${own.join('\n')}\n`);
    result = f.runScript(script, ['--uninstall'], LINUX);
    assert.deepEqual(f.crontabLines(), [], `${label}: ends up empty: ${result.stdout}${result.stderr}`);
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.equal(f.crontabWrites().length, 1, `${label}: one crontab write: ${JSON.stringify(f.crontabWrites())}`);
  }

  // A listing that failed: nothing to build a new crontab from, and the removal is not confirmed.
  for (const [broken, breakListing] of BROKEN_LISTINGS) {
    const label = `${script}, ${broken}`;
    f = scriptHome(t, script, crontab);
    breakListing(f);
    result = f.runScript(script, ['--uninstall'], LINUX);
    assertCrontabNotRewritten(f, crontab, label);
    assertReadFailureReported(result, label);
    assert.doesNotMatch(result.stdout, /Removed .*crontab/i, `${label}: must not report a removal it did not make`);
  }

  // Nothing to remove (no entry, empty crontab, no crontab): no write, exit 0, no complaint.
  for (const existing of [`${OTHER_CRON}\n`, '', null]) {
    const label = `${script}, ${describeCrontab(existing)}`;
    f = scriptHome(t, script, existing);
    result = f.runScript(script, ['--uninstall'], LINUX);
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(f.crontabWrites(), [], `${label}: nothing to remove, so no crontab rewrite`);
    assert.equal(f.crontabText(), existing, `${label}: the crontab is unchanged`);
    assert.doesNotMatch(result.stderr, /crontab/i, `${label}: a user without the entry is not a read failure`);
  }
}

test('install-schedule.sh --uninstall rewrites the crontab only from the one listing it read', t => {
  assertUninstallRemoves(t, { script: INTEL, entries: [INTEL_CRON] });
});

test('install-trainer-schedule.sh --uninstall rewrites the crontab only from the one listing it read', t => {
  assertUninstallRemoves(t, { script: TRAINER, entries: [TRAINER_CRON, REPLIES_CRON] });
});

// ---- macOS: launchd is the scheduler, and the crontab is only cleaned of old entries ----

test('install-schedule.sh on macOS cleans up an old crontab entry only from the one listing it read', darwinOnly, t => {
  const crontab = `${OTHER_CRON}\n${INTEL_CRON}\n${OTHER_CRON_2}\n`;
  const assertLaunchdInstalled = (f, result, label) => {
    assert.equal(result.status, 0, `${label}: the launchd schedule was installed, so the script exits 0: ${result.stdout}${result.stderr}`);
    assert.deepEqual(f.agentFiles(), [path.basename(f.plistPath('intel'))], `${label}: the launchd plist is installed`);
    assert.ok(f.launchctlCalls().includes(`load ${f.plistPath('intel')}`), `${label}: the launchd job is loaded: ${JSON.stringify(f.launchctlCalls())}`);
  };

  // install: the old entry goes, from the first listing; every later listing fails without output.
  let f = scriptHome(t, INTEL, crontab);
  f.failCrontabAfter(1);
  let result = f.runScript(INTEL, ['15 9 * * *']);
  assert.deepEqual(f.crontabLines(), [OTHER_CRON, OTHER_CRON_2],
    `the old entry is removed and every other line is kept, from the one listing that was read: ${result.stdout}${result.stderr}`);
  assertLaunchdInstalled(f, result, 'old entry among other lines');
  assert.equal(f.crontabWrites().length, 1, `one crontab write: ${JSON.stringify(f.crontabWrites())}`);

  // install: a crontab holding only the old entry ends up empty.
  f = scriptHome(t, INTEL, `${INTEL_CRON}\n`);
  result = f.runScript(INTEL, ['15 9 * * *']);
  assert.deepEqual(f.crontabLines(), [], `a crontab of only the old entry ends up empty: ${result.stdout}${result.stderr}`);
  assertLaunchdInstalled(f, result, 'crontab of only the old entry');

  // install: a listing that failed is left alone, and the install still succeeds.
  for (const [broken, breakListing] of BROKEN_LISTINGS) {
    f = scriptHome(t, INTEL, crontab);
    breakListing(f);
    result = f.runScript(INTEL, ['15 9 * * *']);
    assertCrontabNotRewritten(f, crontab, broken);
    assertLaunchdInstalled(f, result, broken);
  }

  // install: the everyday case. No crontab, or one without the entry: no write and no complaint.
  for (const existing of [null, '', `${OTHER_CRON}\n`]) {
    const label = describeCrontab(existing);
    f = scriptHome(t, INTEL, existing);
    result = f.runScript(INTEL, ['15 9 * * *']);
    assertLaunchdInstalled(f, result, label);
    assert.deepEqual(f.crontabWrites(), [], `${label}: nothing to clean up, so no crontab rewrite`);
    assert.equal(f.crontabText(), existing, `${label}: the crontab is unchanged`);
    assert.doesNotMatch(result.stderr, /crontab/i, `${label}: a user without the entry is not a read failure`);
  }
});

test('--uninstall on macOS removes the launchd jobs first and then follows the same crontab rule', darwinOnly, t => {
  for (const [script, plists, entries] of [
    [INTEL, ['intel'], [INTEL_CRON]],
    [TRAINER, ['trainer', 'replies'], [TRAINER_CRON, REPLIES_CRON]],
  ]) {
    const crontab = `${OTHER_CRON}\n${entries.join('\n')}\n${OTHER_CRON_2}\n`;
    let f = scriptHome(t, script, crontab);
    for (const kind of plists) f.writePlist(kind);
    f.failCrontabAfter(1);
    let result = f.runScript(script, ['--uninstall']);
    assert.deepEqual(f.crontabLines(), [OTHER_CRON, OTHER_CRON_2],
      `${script}: its entries are removed and every other line is kept, from the one listing that was read: ${result.stdout}${result.stderr}`);
    assert.equal(result.status, 0, `${script}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(f.agentFiles(), [], `${script}: its launchd plists are removed`);
    assert.equal(f.crontabWrites().length, 1, `${script}: one crontab write: ${JSON.stringify(f.crontabWrites())}`);

    // The crontab cannot be read: the launchd jobs still go, the crontab is left alone, and
    // the script says it could not check the crontab.
    for (const [broken, breakListing] of BROKEN_LISTINGS) {
      const label = `${script}, ${broken}`;
      f = scriptHome(t, script, crontab);
      for (const kind of plists) f.writePlist(kind);
      breakListing(f);
      result = f.runScript(script, ['--uninstall']);
      assert.deepEqual(f.agentFiles(), [], `${label}: its launchd plists are still removed`);
      assertCrontabNotRewritten(f, crontab, label);
      assertReadFailureReported(result, label);
    }

    // The everyday case: launchd jobs and no crontab at all. Exit 0, no write, no complaint.
    f = scriptHome(t, script, null);
    for (const kind of plists) f.writePlist(kind);
    result = f.runScript(script, ['--uninstall']);
    assert.equal(result.status, 0, `${script}, no crontab: ${result.stdout}${result.stderr}`);
    assert.deepEqual(f.agentFiles(), [], `${script}, no crontab: its launchd plists are removed`);
    assert.deepEqual(f.crontabWrites(), [], `${script}, no crontab: no crontab rewrite`);
    assert.doesNotMatch(result.stderr, /crontab/i, `${script}, no crontab: a user without a crontab is not a read failure`);
  }
});

// ---- uninstall.sh with the schedule scripts installed (the normal case) ----

test('uninstall.sh on Linux removes the daily intel and trainer entries through the installed schedule scripts', t => {
  // The podcast script is a do-nothing stand-in here, so this test is about the two real ones.
  const home = options => uninstallHome(t, { helpers: [INTEL, TRAINER], noopHelpers: [PODCAST], ...options });

  // The usual Linux crontab of a Job Quest user: the daily intel entry and nothing else.
  let f = home({ crontab: `${INTEL_CRON}\n` });
  runUninstall(f, LINUX);
  assert.deepEqual(f.crontabLines(), [], 'a crontab of only the daily intel entry ends up empty');

  f = home({ crontab: `${OTHER_CRON}\n${INTEL_CRON}\n${TRAINER_CRON}\n${REPLIES_CRON}\n${OTHER_CRON_2}\n` });
  runUninstall(f, LINUX);
  assert.deepEqual(f.crontabLines(), [OTHER_CRON, OTHER_CRON_2],
    'the daily intel and trainer entries are removed and every other line is kept');

  // The scripts now exit non-zero when they cannot read the crontab. The uninstall must
  // still finish (runUninstall checks that), and nothing is rewritten.
  for (const [broken, breakListing] of BROKEN_LISTINGS) {
    const crontab = `${OTHER_CRON}\n${INTEL_CRON}\n${TRAINER_CRON}\n${REPLIES_CRON}\n`;
    f = home({ crontab });
    breakListing(f);
    runUninstall(f, LINUX);
    assertCrontabNotRewritten(f, crontab, broken);
  }
});

// ---- static check: no blind `crontab -l ... | crontab -` anywhere ----

// Every shell script in the repo's Job Quest code: *.sh files, and files without an
// extension that start with a shell shebang (plugins/job-quest/hooks/run, once it exists).
function shellScripts() {
  const found = [];
  const isShell = file => {
    if (file.endsWith('.sh')) return true;
    if (path.extname(file)) return false;
    const head = fs.readFileSync(file, 'utf8').slice(0, 80).split('\n')[0];
    return /^#!.*\b(?:ba|z|da|k)?sh\b/.test(head);
  };
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'tests'].includes(entry.name)) walk(file);
      } else if (entry.isFile() && isShell(file)) found.push(file);
    }
  };
  for (const dir of ['skill', 'lib', 'plugins', path.join('app', 'scripts')]) {
    if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
  }
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && isShell(path.join(ROOT, entry.name))) found.push(path.join(ROOT, entry.name));
  }
  return found.sort();
}

// A command that continues on the next line (a trailing backslash or a trailing pipe) is
// one line for this check. Comment lines are dropped, so a script may describe the pattern.
function commandLines(text) {
  return text.replace(/\\\n/g, ' ').replace(/\|[ \t]*\n/g, '| ').split('\n')
    .filter(line => !/^\s*#/.test(line));
}

// `crontab -l`, then a pipe somewhere later in the same command, then a `crontab` call that
// is not another listing: the listing's exit status is never looked at before the write.
const BLIND_REWRITE = /\bcrontab\s+-l\b.*\|.*\bcrontab\s+-(?!l\b)/;

test('no Job Quest script pipes `crontab -l` into `crontab -`', () => {
  const scripts = shellScripts();
  for (const name of [INTEL, TRAINER, PODCAST, 'uninstall.sh']) {
    assert.ok(scripts.includes(path.join(ROOT, 'skill', 'bin', name)), `the scan covers skill/bin/${name}`);
  }
  const found = [];
  for (const file of scripts) {
    for (const line of commandLines(fs.readFileSync(file, 'utf8'))) {
      if (BLIND_REWRITE.test(line)) found.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(found, [], 'a crontab rewrite must be built from a listing whose exit status was checked');
});
