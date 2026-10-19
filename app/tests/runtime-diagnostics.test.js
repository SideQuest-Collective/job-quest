'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeDiagnostics, registerRuntimeDiagnostics } = require('../lib/runtime-diagnostics');

function fixture(overrides = {}) {
  const calls = [];
  const runtime = { activeRuntime: 'codex', runtimeDisplayName: 'Codex', runtimeCommand: 'codex' };
  const dashboardCodex = '/Applications/Chat GPT.app/bin/codex';
  const scheduledCodex = '/Users/Test User/.local/bin/codex';
  const scheduledNode = '/opt/homebrew/opt/node@24/bin/node';
  const options = {
    getRuntime: () => runtime,
    env: { HOME: '/Users/product', JOB_QUEST_SYSTEM_HOME: '/Users/Test User', CODEX_HOME: '/Users/Test User/.codex', PATH: '/Applications/Chat GPT.app/bin:/bin', PRIVATE_TOKEN: 'DO_NOT_RETURN_SECRET' },
    nodePath: '/Node Directory/node', nodeVersion: 'v24.13.0', shellHelper: '/Job Quest/lib/runtime-shell.sh',
    async exec(file, args, opts) {
      calls.push({ file, args, opts });
      if (overrides.exec) {
        const result = await overrides.exec(file, args, opts);
        if (result !== undefined) return result;
      }
      if (file === '/bin/bash') {
        if (args.includes(options.shellHelper)) {
          return { stdout: ['/bin:/Users/Test User/.local/bin', '/Users/Test User/.codex', scheduledNode, scheduledCodex, ''].join('\0'), stderr: '' };
        }
        return { stdout: `${dashboardCodex}\n`, stderr: '' };
      }
      if (args[0] === 'login') return { stdout: '', stderr: 'Logged in using ChatGPT\n' };
      return { stdout: file === scheduledNode ? 'v24.13.0\n' : 'codex-cli 0.163.0\n', stderr: '' };
    },
  };
  return { calls, runtime, options, dashboardCodex, scheduledCodex, scheduledNode, check: () => createRuntimeDiagnostics(options)() };
}

test('reports exact dashboard Node and separates runtime paths from scheduler simulation', async () => {
  const f = fixture();
  const result = await f.check();
  assert.deepEqual(result.dashboard.node, { path: '/Node Directory/node', version: 'v24.13.0', ok: true, error: null });
  assert.equal(result.dashboard.runtime.path, f.dashboardCodex);
  assert.equal(result.scheduled.runtime.path, f.scheduledCodex);
  assert.equal(result.scheduled.node.path, f.scheduledNode);
  assert.equal(result.dashboard.runtime.login.ready, true);
  assert.equal(result.scheduled.runtime.login.status, 'ready');
  assert.equal(result.scheduled.simulated, true);
  assert.match(result.scheduled.note, /does not prove.*actual scheduled job/);
  const bootstrap = f.calls.find(call => call.args.includes(f.options.shellHelper));
  assert.equal(bootstrap.opts.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(bootstrap.opts.env.HOME, '/Users/Test User');
  assert.equal(bootstrap.args.at(-2), f.options.shellHelper);
  assert.equal(bootstrap.args.at(-1), 'codex');
  assert.ok(f.calls.every(call => call.opts.timeout >= 3000 && call.opts.timeout <= 5000));
  assert.ok(f.calls.every(call => call.opts.maxBuffer <= 16384));
  assert.equal(f.calls.some(call => call.file === f.options.nodePath), false);
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN_SECRET'), false);
});

test('missing commands return actionable states without attempting a version or login process', async () => {
  const f = fixture({ exec: async file => file === '/bin/bash' ? { stdout: '', stderr: '' } : undefined });
  const result = await f.check();
  assert.equal(result.dashboard.runtime.ok, false);
  assert.equal(result.dashboard.runtime.path, null);
  assert.match(result.dashboard.runtime.error, /not found/);
  assert.equal(result.scheduled.node.ok, false);
  assert.equal(result.scheduled.runtime.login.ready, null);
  assert.equal(f.calls.length, 2);
});

test('version and login timeouts are bounded and sanitized', async () => {
  const f = fixture({ exec: async file => {
    if (file !== '/bin/bash') throw Object.assign(new Error('secret raw failure'), { killed: true, stdout: 'DO_NOT_RETURN_SECRET' });
  } });
  const result = await f.check();
  assert.equal(result.dashboard.runtime.error, 'Command timed out.');
  assert.equal(result.dashboard.runtime.login.error, 'Command timed out.');
  assert.equal(result.scheduled.node.error, 'Command timed out.');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('login result never exposes an API key prefix or raw command errors', async () => {
  const f = fixture({ exec: async (_file, args) => {
    if (args[0] === 'login') return { stdout: 'Logged in using an API key - sk-SECRET_PREFIX', stderr: '' };
  } });
  const result = await f.check();
  assert.equal(result.dashboard.runtime.login.ready, true);
  assert.equal(JSON.stringify(result).includes('sk-SECRET'), false);
});

test('signed-out exit status becomes an explicit not-logged-in state', async () => {
  const f = fixture({ exec: async (_file, args) => {
    if (args[0] === 'login') throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'Not logged in\n' });
  } });
  const result = await f.check();
  assert.deepEqual(result.dashboard.runtime.login, { status: 'not_logged_in', ready: false, error: null });
});

test('unknown versions and disappearing executables are handled without exposing output', async () => {
  const f = fixture({ exec: async (file, args) => {
    if (file.includes('Chat GPT') && args[0] === '--version') return { stdout: 'DO_NOT_RETURN_SECRET', stderr: '' };
    if (file.includes('.local/bin') && args[0] === '--version') throw Object.assign(new Error('DO_NOT_RETURN_SECRET'), { code: 'ENOENT' });
    if (args[0] === 'login') return { stdout: 'unexpected secret output', stderr: '' };
  } });
  const result = await f.check();
  assert.equal(result.dashboard.runtime.version, null);
  assert.equal(result.dashboard.runtime.ok, false);
  assert.equal(result.scheduled.runtime.error, 'Executable was not found.');
  assert.equal(result.dashboard.runtime.login.ready, null);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('Claude versions are checked without guessing authentication commands or running npx', async () => {
  const f = fixture({ exec: async (_file, args) => args[0] === '--version' ? { stdout: '2.1.20 (Claude Code)\n', stderr: '' } : undefined });
  f.runtime.activeRuntime = 'claude';
  f.runtime.runtimeDisplayName = 'Claude Code';
  f.runtime.runtimeCommand = 'claude';
  const result = await f.check();
  assert.equal(result.dashboard.runtime.version, '2.1.20 (Claude Code)');
  assert.equal(result.dashboard.runtime.login.status, 'not_checked');
  assert.equal(f.calls.some(call => call.args[0] === 'login'), false);
  f.calls.length = 0;
  f.runtime.runtimeCommand = 'npx';
  const fallback = await f.check();
  assert.match(fallback.dashboard.runtime.error, /npx fallback was not executed/);
  assert.equal(f.calls.some(call => call.args[0] === '--version' && call.file !== f.scheduledNode), false);
  f.calls.length = 0;
  f.runtime.activeRuntime = 'codex';
  const codexFallback = await f.check();
  assert.equal(codexFallback.dashboard.runtime.login.status, 'not_checked');
  assert.equal(f.calls.some(call => call.file !== '/bin/bash' && call.file !== f.scheduledNode), false);
});

test('route is read-only, disables caching and sanitizes unexpected failures', async () => {
  let handler;
  const app = { get(route, fn) { assert.equal(route, '/api/runtime/diagnostics'); handler = fn; } };
  registerRuntimeDiagnostics(app, { getRuntime() { throw new Error('DO_NOT_RETURN_SECRET'); } });
  const result = {};
  const response = {
    set(name, value) { result[name] = value; return this; },
    status(code) { result.status = code; return this; },
    json(value) { result.body = value; return this; },
  };
  await handler({}, response);
  assert.equal(result.status, 500);
  assert.equal(result['Cache-Control'], 'no-store');
  assert.deepEqual(result.body, { error: 'Runtime diagnostics could not be loaded.' });
});
