'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const plugin = path.resolve(__dirname, '../../skill/bin/xbar/job-quest.5m.sh');

function fixture(t, status, listener = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-xbar-plugin-'));
  t.after(async () => {
    fs.writeFileSync(path.join(home, 'nohup.release'), 'release');
    for (let attempts = 0; attempts < 100 && fs.existsSync(path.join(home, 'nohup.started')) && !fs.existsSync(path.join(home, 'nohup.done')); attempts++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const bin = path.join(home, '.job-quest/bin');
  const stubs = path.join(home, 'stubs');
  const logs = path.join(home, '.job-quest/data/logs');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(stubs);
  fs.mkdirSync(logs, { recursive: true });
  function stub(name, source) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${source}\n`, { mode: 0o755 });
  }
  stub('curl', 'printf "%s\\n" "$*" >> "$HOME/curl.args"\n[ "$STUB_STATUS" = fail ] || printf "%s" "$STUB_STATUS"\nexit "$STUB_CURL_EXIT"');
  stub('lsof', 'printf "%s\\n" "$*" >> "$HOME/lsof.args"\n[ -n "$STUB_LISTENER" ] || exit 1\nprintf "%s\\n" "$STUB_LISTENER"');
  stub('node', 'printf "node\\n" >> "$HOME/node.calls"\nexec "$STUB_NODE_BINARY" "$@"');
  stub('nohup', 'printf "nohup:%s\\n" "$*"\nif read -r line; then printf "unexpected-stdin:%s\\n" "$line"; fi\nprintf started > "$HOME/nohup.started"\nfor ((attempt=0; attempt<500; attempt++)); do [ -f "$HOME/nohup.release" ] && break; /bin/sleep 0.01; done\nprintf done > "$HOME/nohup.done"');
  for (const name of ['start.sh', 'stop.sh', 'restart.sh', 'run-daily-intel.sh', 'install-xbar.sh']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/bash\nexit 99\n', { mode: 0o755 });
  }
  const env = {
    ...process.env, HOME: home, PATH: `${stubs}:/usr/bin:/bin`,
    DATA_DIR: path.dirname(logs), JOB_QUEST_DATA_DIR: path.dirname(logs),
    STUB_CURL_EXIT: status === 'fail' ? (listener ? '22' : '7') : '0', STUB_NODE_BINARY: process.execPath,
    STUB_STATUS: typeof status === 'object' ? JSON.stringify(status) : status,
    STUB_LISTENER: listener, JOB_QUEST_PORT: '49381',
  };
  return {
    home, bin, logs,
    run(args = [], overrides = {}) {
      const result = spawnSync('/bin/bash', [plugin, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000, input: 'caller-input\n' });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
  };
}

const healthy = {
  ok: true, rolesToday: 4, tasks: { done: 2, total: 6 }, quiz: { answered: 1, total: 3, correct: 1 },
  streak: 5, roles: { saved: 3, applied: 2 }, intelIsToday: true, interview: { unlinked: 2 },
};

function action(output, label, script, argument) {
  const line = output.split('\n').find(item => item.startsWith(`${label} | `));
  assert.ok(line, `${label} action missing`);
  assert.ok(line.includes(`shell='${script}'`), line);
  if (argument) assert.ok(line.includes(`param1='${argument}'`), line);
  assert.match(line, /terminal=false/);
  assert.match(line, /refresh=true/);
}

test('running plugin shows dashboard statistics and the running title', t => {
  const f = fixture(t, healthy);
  const output = f.run();
  assert.equal(output.split('\n')[0], 'JQ 🎯 4 · ✓ 2/6');
  assert.match(output, /Server: Running/);
  assert.match(output, /Fresh intel for today/);
});

test('running plugin offers safe stop, restart, and detached intel actions', t => {
  const f = fixture(t, healthy);
  const output = f.run();
  action(output, 'Stop Server', `${f.bin}/stop.sh`);
  action(output, 'Restart Server', `${f.bin}/restart.sh`);
  action(output, 'Refresh Intel Now', plugin, '--refresh-intel');
  assert.doesNotMatch(output, /pkill|Start Server/);
});

test('running plugin links to the actual dashboard page IDs', t => {
  const output = fixture(t, healthy).run();
  for (const [label, id] of [['Today\'s Intel', 'intel'], ['Daily Tasks', 'tasks'], ['Workbooks', 'workbooks'], ['Code Lab', 'codelab'], ['Trainer', 'trainer']]) {
    assert.ok(output.includes(`${label} | href=http://localhost:49381/#${id}`), `${label} link missing`);
  }
  assert.doesNotMatch(output, /#code(?:\s|$)|#tracker/);
});

test('running plugin links unlinked interview sessions to Workbooks', t => {
  const output = fixture(t, healthy).run();
  assert.match(output, /Interview: 2 unlinked session\(s\) \| href=http:\/\/localhost:49381\/#workbooks/);
});

test('plugin opens the dashboard and intel logs when present', t => {
  const f = fixture(t, healthy);
  fs.writeFileSync(path.join(f.logs, 'dashboard.log'), 'dashboard\n');
  fs.writeFileSync(path.join(f.logs, 'daily-intel.log'), 'intel\n');
  const output = f.run();
  assert.ok(output.includes(`View Dashboard Log | shell='/usr/bin/open' param1='${f.logs}/dashboard.log' terminal=false refresh=true`));
  assert.match(output, /View Intel Log/);
});

test('running plugin omits zero interviews and missing dashboard log', t => {
  const output = fixture(t, { ...healthy, interview: { unlinked: 0 } }).run();
  assert.doesNotMatch(output, /Interview:|View Dashboard Log/);
});

test('plugin honors PORT when JOB_QUEST_PORT is not set', t => {
  const output = fixture(t, healthy).run([], { JOB_QUEST_PORT: '', PORT: '49382' });
  assert.match(output, /Open Dashboard \| href=http:\/\/localhost:49382\//);
});

test('plugin reads dashboard logs from the overridden DATA_DIR', t => {
  const f = fixture(t, healthy);
  const data = path.join(f.home, 'custom-data');
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'logs/dashboard.log'), 'custom dashboard\n');
  const output = f.run([], { DATA_DIR: data });
  assert.ok(output.includes(`param1='${data}/logs/dashboard.log'`));
});

test('unresponsive plugin uses the HTTP failure and offers safe stop and restart', t => {
  const f = fixture(t, 'fail', '424242');
  const output = f.run();
  assert.equal(output.split('\n')[0], 'JQ ⚠');
  assert.match(output, /Server: Unresponsive/);
  action(output, 'Stop Server', `${f.bin}/stop.sh`);
  action(output, 'Restart Server', `${f.bin}/restart.sh`);
  assert.doesNotMatch(output, /pkill|Start Server/);
  assert.equal(fs.existsSync(path.join(f.home, 'lsof.args')), false, 'refresh must not scan processes');
});

test('connection refused means stopped without a process scan, even with a stale listener result', t => {
  const f = fixture(t, 'fail', '424242');
  assert.equal(f.run([], { STUB_CURL_EXIT: '7' }).split('\n')[0], 'JQ ⏸');
  assert.equal(fs.existsSync(path.join(f.home, 'lsof.args')), false);
  const calls = fs.readFileSync(path.join(f.home, 'curl.args'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'the bounded status request also probes connectivity');
  assert.match(calls[0], /--connect-timeout 1/);
  assert.match(calls[0], /--max-time 2/);
});

for (const [exit, reason] of [['22', 'HTTP error'], ['28', 'request timeout'], ['52', 'empty HTTP response']]) {
  test(`${reason} means unresponsive without a process scan`, t => {
    const f = fixture(t, 'fail');
    assert.equal(f.run([], { STUB_CURL_EXIT: exit }).split('\n')[0], 'JQ ⚠');
    assert.equal(fs.existsSync(path.join(f.home, 'lsof.args')), false);
  });
}

test('a malformed successful HTTP response proves the port accepts connections without a process scan', t => {
  const f = fixture(t, '<html>not a dashboard</html>');
  assert.equal(f.run().split('\n')[0], 'JQ ⚠');
  assert.equal(fs.existsSync(path.join(f.home, 'lsof.args')), false);
});

test('status fields are parsed with one node call per refresh', t => {
  const f = fixture(t, healthy);
  const output = f.run();
  assert.equal(output.split('\n')[0], 'JQ 🎯 4 · ✓ 2/6');
  assert.match(output, /Streak: 5 day\(s\)/);
  assert.match(output, /Quiz: 1\/3 answered · 1 correct/);
  assert.match(output, /Roles: 3 saved · 2 applied/);
  assert.equal(fs.existsSync(path.join(f.home, 'node.calls')), true, 'node must parse the status');
  assert.equal(fs.readFileSync(path.join(f.home, 'node.calls'), 'utf8'), 'node\n');
  assert.doesNotMatch(fs.readFileSync(plugin, 'utf8'), /python3/);
});

test('status parsing ignores shell syntax and menu injection in metric fields', t => {
  const f = fixture(t, healthy);
  const injected = `$(touch '${f.home}/injected')\nInjected Action | shell=/bin/false`;
  const output = f.run([], { STUB_STATUS: JSON.stringify({ ...healthy, streak: injected, roles: { saved: injected, applied: 2 } }) });
  assert.equal(output.split('\n')[0], 'JQ 🎯 4 · ✓ 2/6');
  assert.match(output, /Streak: 0 day\(s\)/);
  assert.match(output, /Roles: 0 saved · 2 applied/);
  assert.doesNotMatch(output, /Injected Action|touch/);
  assert.equal(fs.existsSync(path.join(f.home, 'injected')), false);
});

test('stopped plugin offers background start and no stop or restart', t => {
  const f = fixture(t, 'fail');
  const output = f.run();
  assert.equal(output.split('\n')[0], 'JQ ⏸');
  assert.match(output, /Server: Stopped/);
  action(output, 'Start Server', `${f.bin}/start.sh`, '--background');
  assert.doesNotMatch(output, /pkill|Stop Server|Restart Server/);
});

test('invalid successful status response is unresponsive when a listener exists', t => {
  const output = fixture(t, '<html>not a dashboard</html>', '424242').run();
  assert.equal(output.split('\n')[0], 'JQ ⚠');
});

test('curl timeout with a dashboard body is still unresponsive', t => {
  const output = fixture(t, healthy, '424242').run([], { STUB_CURL_EXIT: '28' });
  assert.equal(output.split('\n')[0], 'JQ ⚠');
});

test('explicit unhealthy dashboard response is unresponsive even with valid metrics', t => {
  const output = fixture(t, { ...healthy, ok: false }, '424242').run();
  assert.equal(output.split('\n')[0], 'JQ ⚠');
});

test('intel action detaches with nohup, closed stdin, and appends the usual log', async t => {
  const f = fixture(t, healthy);
  fs.writeFileSync(path.join(f.logs, 'daily-intel.log'), 'existing intel\n');
  const output = f.run(['--refresh-intel']);
  assert.equal(output, '');
  for (let attempts = 0; attempts < 100 && !fs.existsSync(path.join(f.home, 'nohup.started')); attempts++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(path.join(f.home, 'nohup.started')), 'detached nohup stub was not invoked');
  assert.equal(fs.existsSync(path.join(f.home, 'nohup.done')), false, 'plugin waited for intel child completion');
  const log = fs.readFileSync(path.join(f.logs, 'daily-intel.log'), 'utf8');
  assert.equal(log, `existing intel\nnohup:${f.bin}/run-daily-intel.sh\n`);
  assert.match(fs.readFileSync(plugin, 'utf8'), /nohup[^\n]*<\s*\/dev\/null[^\n]*&\s*\n\s*disown/);
});
