const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const BIN = path.join(ROOT, 'skill/bin');

function fixture(t, settings = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-dashboard-control-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stubs = path.join(home, 'stubs');
  const data = path.join(home, 'data');
  fs.mkdirSync(stubs);
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  const write = (name, body) => fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  write('lsof', `printf '%s\\n' "$*" >> "$HOME/lsof.log"
[ ! -f "$HOME/stopped" ] || exit 1
if [ -f "$HOME/killed" ]; then touch "$HOME/stopped"; fi
printf '%s\\n' "\${TEST_LISTENERS:-}"`);
  write('ps', `printf '%s\\n' "$*" >> "$HOME/ps.log"
case "$*" in
  *' -p 101'|*' -p 202') echo /usr/local/bin/node ;;
  *) echo /usr/bin/python3 ;;
esac`);
  write('kill', `printf '%s\\n' "$#:$*" >> "$HOME/kill.log"
if [ "\${TEST_RELEASE:-yes}" = yes ]; then touch "$HOME/stopped"; fi
if [ "\${TEST_RELEASE:-yes}" = after-force ] && [ "$1" = -9 ]; then touch "$HOME/killed"; fi`);
  // Bash's kill builtin must also be replaced: these tests never signal a real PID.
  const bashEnv = path.join(home, 'bash-env');
  fs.writeFileSync(bashEnv, `kill() { "$HOME/stubs/kill" "$@"; }
sleep() {
  printf '%s\\n' "$*" >> "$HOME/sleep.log"
  # Advance the clock only in timeout cases, so scheduler load cannot race startup.
  if [ "$TEST_HEALTH" = never ]; then SECONDS=$((SECONDS + 1)); fi
  /bin/sleep 0.01
}
disown() {
  printf '%s\\n' "$*" >> "$HOME/disown.log"
  # Finish the short-lived node stub before accelerating the timeout clock.
  if [ "$TEST_HEALTH" = never ]; then wait "$1"; fi
}
`);
  write('curl', `printf '%s\\n' "$*" >> "$HOME/curl.log"
if [ "\${TEST_START_BARRIER:-}" = yes ] && [ ! -f "$HOME/release-probes" ]; then
  touch "$HOME/probe-$$"
  while [ ! -f "$HOME/release-probes" ]; do /bin/sleep 0.01; done
  exit 7
fi
if [ "\${TEST_HEALTH:-after-start}" = ready ] || { [ "\${TEST_HEALTH:-after-start}" = after-start ] && [ -f "$HOME/started" ]; }; then
  echo '{"ok":true}'
elif [ "\${TEST_HEALTH:-}" = wrong-service ]; then
  echo '{"ok":false}'
else
  exit 7
fi`);
  write('node', `if [[ "$1" == */lib/runtime.js ]]; then
  printf 'export JOB_QUEST_APP_ROOT=%q\\n' "$TEST_REPO"
  printf 'export JOB_QUEST_DATA_DIR=%q\\n' "$TEST_DATA"
  echo 'export JOB_QUEST_ACTIVE_RUNTIME=codex JOB_QUEST_RUNTIME_DISPLAY_NAME=Codex'
elif [ "$1" = -e ]; then
  read -r response || true
  [[ "$response" = '{"ok":true}' ]]
else
  printf '%s\\n' "$*" >> "$HOME/node.log"
  printf '%s\\n' "DATA_DIR=$DATA_DIR PORT=\${PORT:-}" >> "$HOME/node.log"
  if IFS= read -r ignored; then echo unexpected-stdin; else echo stdin-eof; fi
  echo dashboard-output
  echo dashboard-error >&2
  if [ "\${TEST_START_BARRIER:-}" = yes ]; then /bin/sleep 0.1; fi
  touch "$HOME/started"
fi`);
  write('nohup', `printf '%s\\n' "$*" >> "$HOME/nohup.log"
exec "$@"`);
  const env = {
    HOME: home, PATH: `${stubs}:/opt/homebrew/bin:/usr/bin:/bin`, BASH_ENV: bashEnv,
    JOB_QUEST_SYSTEM_HOME: home, CODEX_HOME: path.join(home, '.codex'),
    TEST_REPO: ROOT, TEST_DATA: data, TEST_HEALTH: 'after-start', ...settings,
  };
  const lines = name => fs.existsSync(path.join(home, `${name}.log`))
    ? fs.readFileSync(path.join(home, `${name}.log`), 'utf8').trim().split('\n') : [];
  const run = (script, args = []) => spawnSync('/bin/bash', [path.join(BIN, script), ...args], {
    env, encoding: 'utf8', input: 'caller-input\n', timeout: 10000,
  });
  return { home, data, env, lines, run };
}

test('stop exits successfully without a listener and never signals a process', t => {
  const f = fixture(t);
  const result = f.run('stop.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('kill'), []);
  assert.deepEqual(f.lines('lsof'), ['-nP -t -iTCP:3847 -sTCP:LISTEN']);
});

test('stop targets individual node listeners only and honors JOB_QUEST_PORT before PORT', t => {
  const f = fixture(t, { TEST_LISTENERS: '101\n202\n303', JOB_QUEST_PORT: '4567', PORT: '7890' });
  const result = f.run('stop.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('kill'), ['1:101', '1:202']);
  assert.ok(f.lines('lsof').every(args => args === '-nP -t -iTCP:4567 -sTCP:LISTEN'));
});

test('stop reports failure when an original node listener survives SIGKILL', t => {
  const f = fixture(t, { TEST_LISTENERS: '101\n303', TEST_RELEASE: 'no', PORT: '4568' });
  const result = f.run('stop.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Error: dashboard listener 101 did not exit\./);
  assert.deepEqual(f.lines('kill'), ['1:101', '2:-9 101']);
  assert.equal(f.lines('sleep').length, 10);
  assert.ok(f.lines('lsof').every(args => args.includes('-iTCP:4568')));
});

test('stop succeeds when only an unrelated listener remains', t => {
  const f = fixture(t, { TEST_LISTENERS: '303', TEST_RELEASE: 'no' });
  const result = f.run('stop.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('kill'), []);
});

test('stop deduplicates node pids before both TERM and SIGKILL', t => {
  const f = fixture(t, { TEST_LISTENERS: '101\n101', TEST_RELEASE: 'after-force' });
  const result = f.run('stop.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('kill'), ['1:101', '2:-9 101']);
});

test('background start detaches, redirects stdin, appends both outputs to the dashboard log and polls health', t => {
  const f = fixture(t, { JOB_QUEST_PORT: '4567', PORT: '7890' });
  const log = path.join(f.data, 'logs/dashboard.log');
  fs.writeFileSync(log, 'previous-run\n');
  const result = f.run('start.sh', ['--background']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('nohup'), ['node server.js']);
  assert.equal(f.lines('disown').length, 1);
  assert.deepEqual(f.lines('node'), ['server.js', `DATA_DIR=${f.data} PORT=4567`]);
  assert.equal(fs.readFileSync(log, 'utf8'), 'previous-run\nstdin-eof\ndashboard-output\ndashboard-error\n');
  assert.ok(f.lines('curl').length >= 2);
  assert.ok(f.lines('curl').every(args => args.includes('http://localhost:4567/api/status') && args.includes('--max-time')));
});

test('background start reuses an already healthy dashboard without launching another process', t => {
  const f = fixture(t, { TEST_HEALTH: 'ready' });
  const result = f.run('start.sh', ['--background']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already running/i);
  assert.deepEqual(f.lines('nohup'), []);
  assert.deepEqual(f.lines('node'), []);
});

test('concurrent background starts use one short lock and launch only one server', async t => {
  const f = fixture(t, { TEST_START_BARRIER: 'yes' });
  const launch = () => {
    const child = spawn('/bin/bash', [path.join(BIN, 'start.sh'), '--background'], {
      env: f.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    });
    const state = { done: false, output: '' };
    child.stdout.on('data', chunk => { state.output += chunk; });
    child.stderr.on('data', chunk => { state.output += chunk; });
    state.result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', status => { state.done = true; resolve(status); });
    });
    return state;
  };
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'concurrent starts did not reach the probe barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const probes = () => fs.readdirSync(f.home).filter(name => name.startsWith('probe-')).length;
  const first = launch();
  let second;
  try {
    await waitFor(() => probes() === 1);
    second = launch();
    await waitFor(() => second.done || probes() === 2);
  } finally {
    fs.writeFileSync(path.join(f.home, 'release-probes'), '');
  }
  const results = await Promise.all([first.result, second.result]);
  assert.deepEqual(f.lines('nohup'), ['node server.js']);
  assert.deepEqual(results, [0, 1]);
  assert.match(second.output, /start is already in progress/i);
  assert.equal(fs.existsSync(path.join(f.data, '.start.lock')), false);
  assert.equal(f.run('start.sh', ['--background']).status, 0);
  assert.deepEqual(f.lines('nohup'), ['node server.js']);
});

test('background start honors an explicit DATA_DIR for the server and its log', t => {
  const f = fixture(t);
  const data = path.join(f.home, 'custom data');
  f.env.DATA_DIR = data;
  const result = f.run('start.sh', ['--background']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('node'), ['server.js', `DATA_DIR=${data} PORT=3847`]);
  assert.match(fs.readFileSync(path.join(data, 'logs/dashboard.log'), 'utf8'), /dashboard-output/);
});

test('background start refuses an occupied unhealthy port without launching another server', t => {
  const f = fixture(t, { TEST_LISTENERS: '303', TEST_HEALTH: 'wrong-service' });
  const result = f.run('start.sh', ['--background']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /port.*3847|3847.*port/i);
  assert.deepEqual(f.lines('nohup'), []);
  assert.deepEqual(f.lines('kill'), []);
});

test('background start fails after a bounded health wait and prints the dashboard log path', t => {
  const f = fixture(t, { TEST_HEALTH: 'never' });
  const result = f.run('start.sh', ['--background']);
  assert.equal(result.status, 1, result.stderr);
  assert.ok((result.stdout + result.stderr).includes(path.join(f.data, 'logs/dashboard.log')));
  assert.equal(f.lines('nohup').length, 1);
  assert.ok(f.lines('curl').length >= 2 && f.lines('curl').length <= 17);
  assert.ok(f.lines('sleep').length <= 15);
  assert.equal(fs.existsSync(path.join(f.data, '.start.lock')), false);
});

test('plain start keeps foreground output and does not detach or poll', t => {
  const f = fixture(t, { PORT: '4568' });
  const result = f.run('start.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dashboard-output/);
  assert.match(result.stderr, /dashboard-error/);
  assert.deepEqual(f.lines('nohup'), []);
  assert.deepEqual(f.lines('curl'), []);
  assert.deepEqual(f.lines('node'), ['server.js', `DATA_DIR=${f.data} PORT=4568`]);
});

test('plain start leaves an absent PORT unset so the app can load its .env port', t => {
  const f = fixture(t);
  const result = f.run('start.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('node'), ['server.js', `DATA_DIR=${f.data} PORT=`]);
});

test('restart safely stops listeners, launches detached and waits for the new dashboard health', t => {
  const f = fixture(t, { TEST_LISTENERS: '101', PORT: '4568' });
  const result = f.run('restart.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('kill'), ['1:101']);
  assert.deepEqual(f.lines('nohup'), ['node server.js']);
  assert.ok(f.lines('curl').length >= 2);
  assert.ok(f.lines('curl').every(args => args.includes('http://localhost:4568/api/status')));
});

test('restart propagates a failed health check', t => {
  const f = fixture(t, { TEST_LISTENERS: '101', TEST_HEALTH: 'never' });
  const result = f.run('restart.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(f.lines('kill'), ['1:101']);
  assert.ok((result.stdout + result.stderr).includes(path.join(f.data, 'logs/dashboard.log')));
});

test('restart waits for a force-stopped listener to release the port before starting', t => {
  const f = fixture(t, { TEST_LISTENERS: '101', TEST_RELEASE: 'after-force' });
  const result = f.run('restart.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.lines('kill'), ['1:101', '2:-9 101']);
  assert.deepEqual(f.lines('nohup'), ['node server.js']);
  assert.ok(f.lines('sleep').length >= 6);
});
