// app/tests/jobs-runner.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAgent } = require('../lib/jobs/runner');

const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jq-runner-')); }

test('fake runtime executes the scripted agent and counts attempts', async (t) => {
  process.env.JOB_QUEST_FAKE_AGENT = FAKE;
  t.after(() => { delete process.env.JOB_QUEST_FAKE_AGENT; });
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.fake'));
  fs.writeFileSync(path.join(cwd, '.fake', 'writer.js'),
    "module.exports = async ({ cwd, fs, path, attempt, prompt }) => { fs.writeFileSync(path.join(cwd, 'out-' + attempt + '.txt'), prompt); };");
  const logFile = path.join(cwd, 'writer.log');
  const r1 = await runAgent({ agent: 'writer', prompt: 'hello', cwd, profile: 'write', timeoutMs: 5000, logFile });
  const r2 = await runAgent({ agent: 'writer', prompt: 'again', cwd, profile: 'write', timeoutMs: 5000, logFile });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'out-0.txt'), 'utf-8'), 'hello');
  assert.equal(fs.readFileSync(path.join(cwd, 'out-1.txt'), 'utf-8'), 'again');
  assert.ok(fs.existsSync(logFile));
});

test('timeout kills the process and reports timedOut', async (t) => {
  process.env.JOB_QUEST_FAKE_AGENT = FAKE;
  t.after(() => { delete process.env.JOB_QUEST_FAKE_AGENT; });
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.fake'));
  fs.writeFileSync(path.join(cwd, '.fake', 'slow.js'), 'module.exports = async () => { await new Promise((r) => setTimeout(r, 10000)); };');
  const r = await runAgent({ agent: 'slow', prompt: 'x', cwd, profile: 'read', timeoutMs: 300, logFile: path.join(cwd, 'slow.log') });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});

test('non-zero exit is reported as not ok with stderr', async (t) => {
  process.env.JOB_QUEST_FAKE_AGENT = FAKE;
  t.after(() => { delete process.env.JOB_QUEST_FAKE_AGENT; });
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.fake'));
  fs.writeFileSync(path.join(cwd, '.fake', 'bad.js'), "module.exports = async () => { throw new Error('agent broke'); };");
  const r = await runAgent({ agent: 'bad', prompt: 'x', cwd, profile: 'read', timeoutMs: 5000, logFile: path.join(cwd, 'bad.log') });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /agent broke/);
});

test('self-terminated fake agent reports its signal in the result and agent.log', async (t) => {
  const cwd = tmp();
  const fake = path.join(cwd, 'terminate.js');
  fs.writeFileSync(fake, "process.kill(process.pid, 'SIGTERM');\n");
  const previousFake = process.env.JOB_QUEST_FAKE_AGENT;
  process.env.JOB_QUEST_FAKE_AGENT = fake;
  t.after(() => {
    if (previousFake === undefined) delete process.env.JOB_QUEST_FAKE_AGENT;
    else process.env.JOB_QUEST_FAKE_AGENT = previousFake;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const logFile = path.join(cwd, 'agent.log');
  const result = await runAgent({ agent: 'terminate', prompt: 'x', cwd, profile: 'read', timeoutMs: 5000, logFile });
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGTERM');
  assert.match(fs.readFileSync(logFile, 'utf-8'), /\bsignal=SIGTERM\b/);
});

test('run-agent.sh dry run builds per-profile tool flags for claude', async () => {
  const { execFileSync } = require('node:child_process');
  const script = path.resolve(__dirname, '..', '..', 'skill', 'bin', 'run-agent.sh');
  const cwd = tmp();
  const promptFile = path.join(cwd, 'p.md');
  fs.writeFileSync(promptFile, 'x');
  const out = execFileSync('bash', [script, 'research', promptFile, cwd], {
    env: { ...process.env, JOB_QUEST_RUNTIME_DRY_RUN: '1', JOB_QUEST_AGENT_RUNTIME_OVERRIDE: 'claude' },
  }).toString();
  assert.match(out, /--allowed-tools/);
  assert.match(out, /Write.*WebSearch.*WebFetch/);
  assert.doesNotMatch(out.split('--allowed-tools ')[1].split(' --add-dir')[0], /Read|Edit/);
  assert.match(out, /--add-dir/);
});

test('concurrent fake agents never lose call counts', async (t) => {
  process.env.JOB_QUEST_FAKE_AGENT = FAKE;
  t.after(() => { delete process.env.JOB_QUEST_FAKE_AGENT; });
  const cwd = tmp();
  const runs = [];
  for (let i = 0; i < 6; i++) {
    runs.push(runAgent({ agent: i % 2 ? 'a' : 'b', prompt: 'x', cwd, profile: 'read', timeoutMs: 5000, logFile: path.join(cwd, 'c.log') }));
  }
  await Promise.all(runs);
  const lines = fs.readFileSync(path.join(cwd, '.fake', '.calls.log'), 'utf-8').trim().split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines.filter((l) => l.startsWith('a\t')).length, 3);
});

test('readFakeCalls returns per-agent counts', async (t) => {
  process.env.JOB_QUEST_FAKE_AGENT = FAKE;
  t.after(() => { delete process.env.JOB_QUEST_FAKE_AGENT; });
  const { readFakeCalls } = require('./fixtures/fake-calls');
  const cwd = tmp();
  assert.deepEqual(readFakeCalls(cwd), {});
  await runAgent({ agent: 'x', prompt: 'p', cwd, profile: 'read', timeoutMs: 5000 });
  await runAgent({ agent: 'x', prompt: 'p', cwd, profile: 'read', timeoutMs: 5000 });
  await runAgent({ agent: 'y', prompt: 'p', cwd, profile: 'read', timeoutMs: 5000 });
  assert.deepEqual(readFakeCalls(cwd), { x: 2, y: 1 });
});

test('fix round 1: fake writer/editor cannot write ../progress.json from drafts', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, () => {
  const { spawnSync } = require('node:child_process');
  const root = tmp(), cwd = path.join(root, 'drafts');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'progress.json'), 'learner progress');
  const prompt = path.join(cwd, 'prompt.md');
  fs.writeFileSync(prompt, 'test');
  const fake = path.join(root, 'fake-cli');
  fs.writeFileSync(fake, '#!/bin/bash\nprintf draft > accepted.md\nprintf clobbered > ../progress.json\n');
  fs.chmodSync(fake, 0o755);
  for (const profile of ['write', 'edit']) {
    const r = spawnSync('bash', [path.resolve(__dirname, '../../skill/bin/run-agent.sh'), profile, prompt, cwd], { encoding: 'utf8', env: { ...process.env, JOB_QUEST_AGENT_RUNTIME_OVERRIDE: 'claude', JOB_QUEST_RUNTIME_COMMAND: fake, JOB_QUEST_RUNTIME_DRY_RUN: '0' } });
    assert.ok(fs.existsSync(path.join(cwd, 'accepted.md')), r.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'progress.json'), 'utf8'), 'learner progress', r.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, 'accepted.md'), 'utf8'), 'draft');
    assert.notEqual(r.status, 0);
  }
});
