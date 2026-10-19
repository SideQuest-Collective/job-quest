'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseAccessTrace, buildAccessInvocation, runAccessAgent } = require('../lib/opportunities/access-runner');
const jsonl = events => events.map(value => JSON.stringify(value)).join('\n');
const runtime = (id = 'codex') => ({ activeRuntime: id, runtimeCommand: id, runtimeCommandArgs: id === 'codex' ? ['exec'] : ['--print'] });

test('Codex proof requires a completed successful MCP result, excludes shell and final claims', () => {
  const parsed = parseAccessTrace('codex', jsonl([
    { type: 'item.completed', item: { id: 'shell', type: 'command_execution', exit_code: 0, aggregated_output: 'identity@example.test' } },
    { type: 'item.started', item: { id: 'pending', type: 'mcp_tool_call', server: 'gmail', tool: 'get_profile' } },
    { type: 'item.completed', item: { id: 'good', type: 'mcp_tool_call', server: 'gmail', tool: 'get_profile', status: 'completed', result: { content: [{ type: 'text', text: '{"email":"identity@example.test"}' }] } } },
    { type: 'item.completed', item: { id: 'bad', type: 'mcp_tool_call', server: 'gmail', tool: 'read_message', status: 'completed', result: { isError: true, content: [] } } },
    { type: 'item.completed', item: { id: 'text', type: 'agent_message', text: 'All verified.' } },
  ]));
  assert.equal(parsed.text, 'All verified.');
  assert.equal(parsed.traceSupported, true);
  assert.deepEqual(parsed.toolEvidence.map(({ id, name, ok }) => ({ id, name, ok })), [
    { id: 'pending', name: 'gmail/get_profile', ok: false },
    { id: 'good', name: 'gmail/get_profile', ok: true },
    { id: 'bad', name: 'gmail/read_message', ok: false },
  ]);
  assert.match(parsed.toolEvidence[1].resultText, /identity@example.test/);
  assert.equal(parsed.toolEvidence[2].resultText, undefined);
});

test('Claude proof correlates MCP tool use with its actual result', () => {
  const parsed = parseAccessTrace('claude', jsonl([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call1', name: 'mcp__mail__get_profile', input: { private: 'never returned' } }, { type: 'tool_use', id: 'call2', name: 'mcp__mail__search' }, { type: 'tool_use', id: 'shell', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call1', content: [{ type: 'text', text: 'user@example.test' }] }, { type: 'tool_result', tool_use_id: 'call2', is_error: true, content: 'denied' }, { type: 'tool_result', tool_use_id: 'unseen', content: 'fake' }] } },
    { type: 'result', subtype: 'success', result: '{"verified":true}' },
  ]));
  assert.equal(parsed.toolEvidence.length, 2);
  assert.equal(parsed.toolEvidence[0].ok, true);
  assert.match(parsed.toolEvidence[0].resultText, /user@example.test/);
  assert.equal(parsed.toolEvidence[1].ok, false);
  assert.doesNotMatch(JSON.stringify(parsed), /never returned/);
});

test('unknown trace and model success alone cannot prove account access', () => {
  const parsed = parseAccessTrace('codex', jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: 'verified' } }]));
  assert.equal(parsed.traceSupported, false);
  assert.deepEqual(parsed.toolEvidence, []);
  assert.match(parsed.capabilityNote, /cannot be confirmed/);
});

test('wrapped errors fail proof and successful evidence is bounded', () => {
  const parsed = parseAccessTrace('codex', jsonl([
    { type: 'item.completed', item: { id: 'wrapped', type: 'mcp_tool_call', tool: 'profile', status: 'completed', result: { content: [{ type: 'text', text: '{"error":"denied"}' }] } } },
    { type: 'item.completed', item: { id: 'large', type: 'mcp_tool_call', tool: 'search', status: 'completed', result: { value: 'x'.repeat(30000) } } },
  ]));
  assert.equal(parsed.toolEvidence[0].ok, false);
  assert.ok(Buffer.byteLength(parsed.toolEvidence[1].resultText) <= 8192);
});

test('safe command construction rejects install fallbacks and injected flags', () => {
  const codex = buildAccessInvocation(runtime(), '/tmp/output');
  assert.ok(codex.args.includes('read-only'));
  assert.ok(codex.args.includes('--ephemeral'));
  assert.ok(!codex.args.some(arg => /bypass|approve/.test(arg)));
  const claude = buildAccessInvocation(runtime('claude'), '/tmp/output');
  assert.ok(claude.args.includes('plan'));
  assert.ok(claude.args.includes('Read,Glob,Grep'));
  assert.throws(() => buildAccessInvocation({ ...runtime('claude'), runtimeCommand: 'npx' }, '/tmp/output'), { code: 'ACCESS_RUNTIME_UNAVAILABLE' });
  assert.throws(() => buildAccessInvocation({ ...runtime(), runtimeCommandArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox'] }, '/tmp/output'), { code: 'ACCESS_RUNTIME_UNAVAILABLE' });
});

async function fixture(t, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'access-runner-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, 'codex');
  await fs.writeFile(command, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { directory, getRuntime: () => ({ ...runtime(), runtimeCommand: command }) };
}

test('runs selected direct runtime with stdin prompt and reads final output without shell interpolation', async t => {
  const setup = await fixture(t, `
    const fs = require('node:fs');
    let prompt=''; process.stdin.on('data', chunk => prompt += chunk);
    process.stdin.on('end', () => {
      const args=process.argv.slice(2);
      if (!args.includes('read-only')) process.exit(3);
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({prompt}));
      console.log(JSON.stringify({type:'item.completed',item:{id:'call',type:'mcp_tool_call',tool:'get_profile',server:'mail',status:'completed',result:{email:'person@example.test'}}}));
    });
  `);
  const prompt = 'Read only. literal $(touch /tmp/should-not-run) `whoami`';
  const result = await runAccessAgent({ ...setup, cwd: setup.directory, prompt });
  assert.equal(JSON.parse(result.text).prompt, prompt);
  assert.equal(result.toolEvidence[0].ok, true);
});

test('nonzero failure omits private runtime stderr', async t => {
  const setup = await fixture(t, "console.error('TOKEN=private-secret'); process.exit(2);");
  await assert.rejects(runAccessAgent({ ...setup, cwd: setup.directory, prompt: 'check' }), error => {
    assert.equal(error.code, 'ACCESS_RUNTIME_FAILED');
    assert.doesNotMatch(error.message, /private-secret/);
    return true;
  });
});

test('bounds runtime duration and output', async t => {
  const setup = await fixture(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(runAccessAgent({ ...setup, cwd: setup.directory, prompt: 'check', timeoutMs: 50 }), { code: 'ACCESS_TIMEOUT' });
  const noisy = await fixture(t, "process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000);");
  await assert.rejects(runAccessAgent({ ...noisy, cwd: noisy.directory, prompt: 'check', timeoutMs: 2000 }), { code: 'ACCESS_OUTPUT_LIMIT' });
});

test('timeout terminates runtime descendants as a process group', async t => {
  const setup = await fixture(t, `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    require('node:fs').writeFileSync('descendant.pid', String(child.pid));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(runAccessAgent({ ...setup, cwd: setup.directory, prompt: 'check', timeoutMs: 800 }), { code: 'ACCESS_TIMEOUT' });
  const pid = Number(await fs.readFile(path.join(setup.directory, 'descendant.pid'), 'utf8'));
  // A killed child may briefly remain a zombie awaiting the OS reaper.
  const { execFileSync } = require('node:child_process');
  let state = '';
  try { state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); } catch (_) {}
  assert.ok(!state || state.startsWith('Z'), `descendant remains alive: ${state}`);
});

test('evidence byte cap holds across a partial UTF8 code point', () => {
  const parsed = parseAccessTrace('codex', jsonl([
    { type: 'item.completed', item: { id: 'unicode', type: 'mcp_tool_call', tool: 'read', status: 'completed', result: { content: '€'.repeat(10000) } } },
  ]));
  assert.ok(Buffer.byteLength(parsed.toolEvidence[0].resultText) <= 8192);
});
