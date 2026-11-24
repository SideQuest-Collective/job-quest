// T-0031: a temporary HOME laid out like an installed Job Quest, for schedule checks.
// ~/.job-quest/bin holds copies of the three schedule scripts from skill/bin and
// ~/.job-quest/app/lib holds lib/runtime-shell.sh and lib/runtime.js, which is
// where an installed script finds its runtime helpers. Nothing here touches the
// real ~/Library/LaunchAgents, crontab, launchctl or ~/.claude:
//   launchctl  logs its arguments to <dir>/launchctl.log and prints nothing
//   crontab    `-l` prints <dir>/crontab.txt. With no crontab.txt it fails the way cron
//              does for a user without one ("crontab: no crontab for tester", exit 1).
//              After failCrontab() it prints whatever crontab.txt holds and then fails
//              with a different error (exit 1). After failCrontabAfter(n) the first n
//              listings behave normally and every later one prints nothing and fails with
//              that same error. Every listing is logged to <dir>/crontab-lists.log. Any
//              other call logs to <dir>/crontab-writes.log, reads all of stdin and then
//              replaces crontab.txt
//   bash       `bash -lc` runs without login profiles (runtime.js command lookup)
//   claude, codex  exit 0
//   curl wget git npm osascript brew ssh sudo open  tripwires (fake-claude.js)
// The stubs only work through PATH. So before any script runs, scheduleHome() calls
// assertNoAbsoluteSchedulerPaths(), which fails the test if a shell file under test names
// launchctl or crontab by an absolute path (or through `command -p`): that would reach
// the real launchd and crontab.
// Pass LINUX ({ OSTYPE: 'linux-gnu' }) as runScript's third argument to take a script's
// Linux (crontab) branch on any host; the scripts pick their platform from $OSTYPE.
// uninstallHome() and runUninstall() do the same for skill/bin/uninstall.sh, with lsof, ps
// and rm stubbed as in uninstall-script.test.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fake = require('./fake-claude');

const ROOT = path.resolve(__dirname, '../../..');
const SKILL_BIN = path.join(ROOT, 'skill', 'bin');
const SCRIPTS = ['install-schedule.sh', 'install-trainer-schedule.sh', 'install-podcast-schedule.sh'];
const LABELS = {
  intel: 'com.sidequest.job-quest.daily-intel',
  trainer: 'com.sidequest.job-quest.interview-trainer',
  replies: 'com.sidequest.job-quest.trainer-replies',
  podcast: 'com.sidequest.job-quest.daily-podcast',
};
const MARKERS = {
  intel: '# job-quest-daily-intel',
  trainer: '# job-quest-interview-trainer',
  replies: '# job-quest-trainer-replies',
  podcast: '# job-quest-daily-podcast',
};
const LINUX = { OSTYPE: 'linux-gnu' };

// Every shell file the schedule and uninstall tests execute, directly or through `source`,
// plus everything in the plugin's hooks directory once it exists.
function shellFilesUnderTest() {
  const files = [
    ...SCRIPTS.map(name => path.join(SKILL_BIN, name)),
    path.join(SKILL_BIN, 'uninstall.sh'),
    path.join(SKILL_BIN, 'lib', 'dashboard-control.sh'),
    path.join(ROOT, 'lib', 'runtime-shell.sh'),
  ];
  const hooks = path.join(ROOT, 'plugins', 'job-quest', 'hooks');
  if (fs.existsSync(hooks)) {
    for (const name of fs.readdirSync(hooks)) {
      const file = path.join(hooks, name);
      if (fs.statSync(file).isFile()) files.push(file);
    }
  }
  return files.filter(file => fs.existsSync(file));
}

// /bin/launchctl, /usr/bin/crontab, /opt/x/bin/launchctl, `command -p crontab`, ...
const ABSOLUTE_SCHEDULER = /(?:\/[\w.-]+)+\/(?:launchctl|crontab)(?![\w.-])|\bcommand\s+-p\s+(?:launchctl|crontab)\b/;

function absoluteSchedulerPaths(files = shellFilesUnderTest()) {
  const found = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (ABSOLUTE_SCHEDULER.test(line)) found.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

function assertNoAbsoluteSchedulerPaths() {
  const found = absoluteSchedulerPaths();
  if (found.length) {
    throw new Error('launchctl and crontab must be called by bare name so the test stubs on PATH intercept them; '
      + `refusing to run scripts that would reach the real ones:\n${found.join('\n')}`);
  }
}

function plistXml(label, calendarXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>/nonexistent/runner.sh</string></array>
  <key>StartCalendarInterval</key>
${calendarXml}
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

// options.install: copy scripts and runtime helpers into ~/.job-quest (default true).
// options.scripts: which of the three schedule scripts to copy (default all).
// options.runtime: 'ok' copies lib/runtime.js; 'crash' installs a runtime.js that throws,
// the way a broken or half-updated checkout fails to load the runtime.
function scheduleHome(t, { install = true, runtime = 'ok', scripts = SCRIPTS } = {}) {
  assertNoAbsoluteSchedulerPaths();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-schedule-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const stubs = path.join(dir, 'stubs');
  const tmp = path.join(dir, 'tmp');
  const productHome = path.join(home, '.job-quest');
  const bin = path.join(productHome, 'bin');
  const appLib = path.join(productHome, 'app', 'lib');
  const data = path.join(productHome, 'data');
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const tripwireLog = path.join(dir, 'tripwire.log');
  for (const d of [stubs, tmp, data, agents]) fs.mkdirSync(d, { recursive: true });

  if (install) {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(appLib, { recursive: true });
    for (const name of scripts) {
      fs.copyFileSync(path.join(SKILL_BIN, name), path.join(bin, name));
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    fs.copyFileSync(path.join(ROOT, 'lib', 'runtime-shell.sh'), path.join(appLib, 'runtime-shell.sh'));
    if (runtime === 'crash') {
      fs.writeFileSync(path.join(appLib, 'runtime.js'), "throw new Error('fixture: runtime helper crashed');\n");
    } else {
      fs.copyFileSync(path.join(ROOT, 'lib', 'runtime.js'), path.join(appLib, 'runtime.js'));
    }
  }

  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  for (const [name, body] of Object.entries({
    claude: 'exit 0',
    codex: 'exit 0',
    bash: 'if [ "$1" = -lc ]; then shift; exec /bin/bash -c "$@"; fi\nexec /bin/bash "$@"',
    launchctl: 'echo "$*" >> "$SCHEDULE_TEST_DIR/launchctl.log"; exit 0',
    crontab: [
      'if [ "${1:-}" = -l ]; then',
      '  echo list >> "$SCHEDULE_TEST_DIR/crontab-lists.log"',
      '  if [ -f "$SCHEDULE_TEST_DIR/crontab-fail-after" ]; then',
      '    listings=$(grep -c . "$SCHEDULE_TEST_DIR/crontab-lists.log")',
      '    if [ "$listings" -gt "$(cat "$SCHEDULE_TEST_DIR/crontab-fail-after")" ]; then',
      '      echo "crontab: fixture failure: the crontab could not be read" >&2; exit 1',
      '    fi',
      '  fi',
      '  if [ -f "$SCHEDULE_TEST_DIR/crontab-fail" ]; then',
      '    [ -f "$SCHEDULE_TEST_DIR/crontab.txt" ] && cat "$SCHEDULE_TEST_DIR/crontab.txt"',
      '    echo "crontab: fixture failure: the crontab could not be read" >&2; exit 1',
      '  fi',
      '  if [ ! -f "$SCHEDULE_TEST_DIR/crontab.txt" ]; then echo "crontab: no crontab for tester" >&2; exit 1; fi',
      '  cat "$SCHEDULE_TEST_DIR/crontab.txt"; exit 0',
      'fi',
      'echo "$*" >> "$SCHEDULE_TEST_DIR/crontab-writes.log"',
      // Like the real crontab, read all of stdin before replacing anything, so a pipeline
      // that lists and rewrites in one go does not truncate what it is still reading.
      'cat > "$SCHEDULE_TEST_DIR/crontab.new" && mv "$SCHEDULE_TEST_DIR/crontab.new" "$SCHEDULE_TEST_DIR/crontab.txt"',
    ].join('\n'),
  })) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  fake.writeTripwires(stubs, ['curl', 'wget', 'git', 'npm', 'osascript', 'brew', 'ssh', 'sudo', 'open']);

  const env = {
    HOME: home,
    PATH: `${stubs}:/usr/bin:/bin`,
    TMPDIR: tmp,
    JOB_QUEST_SYSTEM_HOME: home,
    SCHEDULE_TEST_DIR: dir,
    TRIPWIRE_LOG: tripwireLog,
  };

  const plistPath = kind => path.join(agents, `${LABELS[kind]}.plist`);
  const weekdays = [1, 2, 3, 4, 5]
    .map(d => `    <dict><key>Minute</key><integer>3</integer><key>Hour</key><integer>7</integer><key>Weekday</key><integer>${d}</integer></dict>`)
    .join('\n');
  const trainerHours = Array.from({ length: 13 }, (_, i) => 9 + i)
    .map(h => `    <dict><key>Minute</key><integer>0</integer><key>Hour</key><integer>${h}</integer></dict>`)
    .join('\n');
  const writePlist = kind => {
    const calendar = kind === 'intel' ? `  <array>\n${weekdays}\n  </array>`
      : kind === 'trainer' ? `  <array>\n${trainerHours}\n  </array>`
        : '  <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>';
    fs.writeFileSync(plistPath(kind), plistXml(LABELS[kind], calendar));
    return plistPath(kind);
  };

  const readLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  const launchctlCalls = () => readLines(path.join(dir, 'launchctl.log'));
  const crontabWrites = () => readLines(path.join(dir, 'crontab-writes.log'));
  const tripwires = () => fake.readTripwires(tripwireLog);
  const agentFiles = () => fs.readdirSync(agents).sort();
  const writeData = (name, value) => {
    fs.writeFileSync(path.join(data, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  const crontabFile = path.join(dir, 'crontab.txt');
  const writeCrontab = text => fs.writeFileSync(crontabFile, text);
  const crontabText = () => (fs.existsSync(crontabFile) ? fs.readFileSync(crontabFile, 'utf8') : null);
  // From now on `crontab -l` prints what crontab.txt holds and then fails (exit 1) with an
  // error that is not "no crontab for <user>".
  const failCrontab = () => fs.writeFileSync(path.join(dir, 'crontab-fail'), '');
  // The first n `crontab -l` calls behave normally; every later one prints nothing and
  // fails (exit 1) with that error. failCrontabAfter(1) catches code that lists the crontab
  // a second time to build the new one instead of reusing the listing it already checked;
  // failCrontabAfter(0) is a listing that fails without printing anything.
  const failCrontabAfter = n => fs.writeFileSync(path.join(dir, 'crontab-fail-after'), `${n}\n`);
  const crontabLines = () => (crontabText() || '').split('\n').filter(Boolean);

  // Run an installed schedule script with the fixture environment.
  const runScript = (name, args = [], extraEnv = {}) => {
    const result = spawnSync('/bin/bash', [path.join(bin, name), ...args], {
      env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000, input: '',
    });
    if (result.error) throw result.error;
    return result;
  };

  return {
    dir, home, stubs, bin, data, agents, env,
    plistPath, writePlist, writeData, agentFiles, launchctlCalls, crontabWrites, tripwires, runScript,
    writeCrontab, crontabText, crontabLines, failCrontab, failCrontabAfter,
  };
}

// A scheduleHome for running skill/bin/uninstall.sh from the checkout.
// options.helpers: the real schedule scripts installed in ~/.job-quest/bin. For a script
//   that is not there, uninstall.sh has to remove that job itself (its fallback).
// options.noopHelpers: schedule scripts installed as an executable that does nothing, so
//   uninstall.sh takes its "helper installed" path for that job and the job's fallback,
//   with its crontab listing, never runs.
// options.plists: launchd plists to create (keys of LABELS).
// options.crontab: the crontab text, or null for a user without a crontab.
// options.crontabFails: failCrontab(). options.crontabFailsAfter: failCrontabAfter(n).
function uninstallHome(t, {
  helpers = [], noopHelpers = [], plists = [], crontab = null, crontabFails = false, crontabFailsAfter = null,
} = {}) {
  const f = scheduleHome(t, { install: helpers.length > 0, scripts: helpers });
  for (const [name, body] of Object.entries({
    lsof: 'exit 1',
    ps: 'exit 1',
    // The uninstaller also cleans global /tmp globs; never let tests touch those.
    rm: 'for arg in "$@"; do case "$arg" in -*) ;; "$SCHEDULE_TEST_DIR"/*) ;; *) exit 0 ;; esac; done; /bin/rm "$@"',
  })) {
    fs.writeFileSync(path.join(f.stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  if (noopHelpers.length) fs.mkdirSync(f.bin, { recursive: true });
  for (const name of noopHelpers) {
    fs.writeFileSync(path.join(f.bin, name), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  for (const kind of plists) f.writePlist(kind);
  if (crontab !== null) f.writeCrontab(crontab);
  if (crontabFails) f.failCrontab();
  if (crontabFailsAfter !== null) f.failCrontabAfter(crontabFailsAfter);
  return f;
}

// Run the checkout's uninstall.sh --yes in the fixture; it must always finish.
function runUninstall(f, extraEnv = {}) {
  const result = spawnSync('/bin/bash', [path.join(SKILL_BIN, 'uninstall.sh'), '--yes'], {
    env: { ...f.env, ...extraEnv }, encoding: 'utf8', timeout: 15000, input: '',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Job Quest has been uninstalled/);
  return result;
}

module.exports = {
  ROOT, LABELS, MARKERS, LINUX, scheduleHome, uninstallHome, runUninstall,
  shellFilesUnderTest, absoluteSchedulerPaths, assertNoAbsoluteSchedulerPaths,
};
