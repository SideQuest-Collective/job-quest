const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UNINSTALL = path.resolve(__dirname, '../../skill/bin/uninstall.sh');

function copiedUninstall(t, { helper = 'bin', reinstall = false, stopFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-uninstall-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const bin = path.join(home, '.job-quest/bin');
  const stubs = path.join(dir, 'stubs');
  const tmp = path.join(dir, 'tmp');
  for (const directory of [bin, stubs, tmp]) fs.mkdirSync(directory, { recursive: true });
  const copy = path.join(tmp, 'uninstall-copy.sh');
  fs.copyFileSync(UNINSTALL, copy);
  fs.copyFileSync(UNINSTALL, path.join(bin, 'uninstall.sh'));
  if (helper) {
    const helperRoot = helper === 'script' ? tmp : helper === 'bin' ? bin : path.join(home, '.job-quest/app/skill/bin');
    fs.mkdirSync(path.join(helperRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(helperRoot, 'lib/dashboard-control.sh'), stopFails
      ? 'stop_dashboard_server() { echo "stub stop failed" >&2; return 1; }\n'
      : fs.readFileSync(path.join(path.dirname(UNINSTALL), 'lib/dashboard-control.sh')));
  }
  const commands = {
    lsof: 'echo "$*" >> "$COPY_TEST_DIR/lsof.log"; [ -f "$COPY_TEST_DIR/stopped" ] || echo 101',
    ps: 'echo /usr/local/bin/node',
    kill: 'echo "$*" >> "$COPY_TEST_DIR/kill.log"; touch "$COPY_TEST_DIR/stopped"',
    launchctl: 'echo "$*" >> "$COPY_TEST_DIR/launchctl.log"',
    crontab: 'echo "$*" >> "$COPY_TEST_DIR/crontab.log"; exit 1',
    open: 'exit 0',
    curl: "printf '%s\\n' 'echo fixture-install-complete'",
    mktemp: '[ "$#" -eq 0 ] || exit 1; /usr/bin/mktemp "$COPY_TEST_DIR/tmp/uninstall.XXXXXX"',
    cp: 'printf "%s\\n" "$@" >> "$COPY_TEST_DIR/cp.log"; /bin/cp "$@"',
    // The uninstaller also cleans global /tmp globs; never let tests touch those.
    rm: 'for arg in "$@"; do case "$arg" in -*) ;; "$COPY_TEST_DIR"/*) ;; *) exit 0 ;; esac; done; /bin/rm "$@"',
  };
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const bashEnv = path.join(dir, 'bash-env');
  fs.writeFileSync(bashEnv, 'kill() { "$COPY_TEST_DIR/stubs/kill" "$@"; }\n');
  const result = spawnSync('/bin/bash', [reinstall ? path.join(path.dirname(UNINSTALL), 'reinstall.sh') : copy, '--yes'], {
    env: { HOME: home, TMPDIR: tmp, PATH: `${stubs}:/usr/bin:/bin`, BASH_ENV: bashEnv, COPY_TEST_DIR: dir },
    encoding: 'utf8', timeout: 10000,
  });
  return { result, dir, home, bin, tmp };
}

for (const helper of ['script', 'bin', 'app', null]) {
  test(`temporary uninstall copy gets past server stop with ${helper || 'no'} helper`, t => {
    const { result, dir, home } = copiedUninstall(t, { helper });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Job Quest has been uninstalled/);
    assert.ok(fs.existsSync(path.join(dir, 'crontab.log')), 'schedule cleanup follows server stop');
    assert.equal(fs.existsSync(path.join(home, '.job-quest')), false);
    if (helper) assert.equal(fs.readFileSync(path.join(dir, 'kill.log'), 'utf8'), '101\n');
    else assert.match(result.stderr, /Warning:.*helper.*not found.*skipping server stop/i);
  });
}

test('temporary uninstall copy warns and continues when the stop helper fails', t => {
  const { result, dir } = copiedUninstall(t, { stopFails: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Warning:.*stop/i);
  assert.ok(fs.existsSync(path.join(dir, 'crontab.log')));
  assert.match(result.stdout, /Job Quest has been uninstalled/);
});

test('reinstall copies the installed uninstaller and reaches the fresh install step', t => {
  const { result, dir, bin, tmp } = copiedUninstall(t, { reinstall: true });
  assert.equal(result.status, 0, result.stderr);
  const [source, destination] = fs.readFileSync(path.join(dir, 'cp.log'), 'utf8').trim().split('\n');
  assert.equal(source, path.join(bin, 'uninstall.sh'));
  assert.ok(destination.startsWith(`${tmp}/`), `temporary copy ${destination} must be under ${tmp}`);
  assert.notEqual(destination, source);
  assert.equal(fs.existsSync(destination), false, 'reinstall removes its temporary copy');
  assert.match(result.stdout, /Step 2\/2: Installing fresh/);
  assert.match(result.stdout, /fixture-install-complete/);
  assert.match(result.stdout, /Reinstall complete/);
  assert.ok(fs.existsSync(path.join(dir, 'crontab.log')));
});

function exerciseStopLogic(t, releaseAfter = 1, finalListeners = '101 202 303', expectedStatus = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-uninstall-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = fs.readFileSync(UNINSTALL, 'utf8');
  // Exercise only the shared stop helper: never run uninstall or its cleanup.
  assert.match(script, /source "\$helper"/);
  assert.doesNotMatch(script, /stop_dashboard_server\(\)/, 'uninstall must use the one shared implementation');
  const helper = path.resolve(path.dirname(UNINSTALL), 'lib/dashboard-control.sh');
  const stubs = {
    lsof: `#!/bin/bash
printf '%s\\n' "$*" >> "$STOP_TEST_DIR/lsof.log"
count=0
[ ! -f "$STOP_TEST_DIR/count" ] || read -r count < "$STOP_TEST_DIR/count"
count=$((count + 1))
printf '%s\\n' "$count" > "$STOP_TEST_DIR/count"
if [ "$count" -gt "$RELEASE_AFTER" ]; then exit 1; fi
if [ "$count" -ge 7 ]; then
  printf '%s\\n' $FINAL_LISTENERS
else
  printf '%s\\n' 101 202 303
fi
case " $* " in
  *' -sTCP:LISTEN '*) ;;
  *) printf '%s\\n' 404 ;;
esac
`,
    ps: `#!/bin/bash
printf '%s\\n' "$*" >> "$STOP_TEST_DIR/ps.log"
case "$*" in
  '-o comm= -p 101') printf '%s\\n' /usr/local/bin/node ;;
  '-o comm= -p 202') printf '%s\\n' node ;;
  '-o comm= -p 303') printf '%s\\n' /usr/bin/python3 ;;
  '-o comm= -p 404') printf '%s\\n' node ;;
  *) exit 1 ;;
esac
`,
    sleep: `#!/bin/bash
printf '%s\\n' "$*" >> "$STOP_TEST_DIR/sleep.log"
`,
  };
  for (const [name, content] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
  }
  const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
kill() { printf '%s\\n' "$#:$*" >> "$STOP_TEST_DIR/kill.log"; }
source "$STOP_TEST_HELPER"
stop_dashboard_server
`], {
    encoding: 'utf8',
    env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, STOP_TEST_DIR: dir, STOP_TEST_HELPER: helper, RELEASE_AFTER: String(releaseAfter), FINAL_LISTENERS: finalListeners },
  });
  assert.equal(result.status, expectedStatus, result.stderr);
  if (expectedStatus) assert.match(result.stderr, /Error: dashboard listener \d+ did not exit/);
  const lines = name => fs.existsSync(path.join(dir, `${name}.log`))
    ? fs.readFileSync(path.join(dir, `${name}.log`), 'utf8').trim().split('\n') : [];
  return { lines };
}

test('uninstall stops each node listener separately without killing clients or non-node listeners', t => {
  const { lines } = exerciseStopLogic(t);
  assert.deepEqual(lines('kill'), ['1:101', '1:202']);
  assert.ok(lines('lsof').every(args => args === '-nP -t -iTCP:3847 -sTCP:LISTEN'));
  assert.deepEqual(lines('ps'), ['-o comm= -p 101', '-o comm= -p 202', '-o comm= -p 303']);
});

test('uninstall waits for the listening port to become free and then stops polling', t => {
  const { lines } = exerciseStopLogic(t, 3);
  assert.equal(lines('lsof').length, 4);
  assert.deepEqual(lines('sleep'), ['1', '1']);
});

test('uninstall bounds its wait when the listening port stays occupied', t => {
  const { lines } = exerciseStopLogic(t, 99, '101 202 303', 1);
  assert.equal(lines('lsof').length, 13);
  assert.deepEqual(lines('sleep'), Array(10).fill('1'));
  assert.deepEqual(lines('kill'), ['1:101', '1:202', '2:-9 101', '2:-9 202']);
});

test('uninstall sends SIGKILL once only to node listeners still present after the bounded wait', t => {
  const { lines } = exerciseStopLogic(t, 99, '202 303', 1);
  assert.deepEqual(lines('sleep'), Array(10).fill('1'));
  assert.deepEqual(lines('kill'), ['1:101', '1:202', '2:-9 202']);
  assert.deepEqual(lines('ps'), [
    '-o comm= -p 101', '-o comm= -p 202', '-o comm= -p 303',
    '-o comm= -p 202', '-o comm= -p 303',
    ...Array(6).fill('-o comm= -p 202'),
  ]);
  assert.ok(lines('lsof').every(args => args === '-nP -t -iTCP:3847 -sTCP:LISTEN'));
});

test('uninstall skips SIGKILL when listeners exit during the last wait', t => {
  const { lines } = exerciseStopLogic(t, 6);
  assert.equal(lines('lsof').length, 8);
  assert.deepEqual(lines('sleep'), ['1', '1', '1', '1', '1']);
  assert.deepEqual(lines('kill'), ['1:101', '1:202']);
});

test('uninstall does not SIGKILL a new node listener that never received SIGTERM', t => {
  const { lines } = exerciseStopLogic(t, 99, '202 404', 1);
  assert.deepEqual(lines('kill'), ['1:101', '1:202', '2:-9 202']);
});
