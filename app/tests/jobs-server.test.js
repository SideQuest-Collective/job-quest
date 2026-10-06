// app/tests/jobs-server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function withServer(dataDir, fn) {
  const port = 4400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, INTERVIEW_HOME: path.join(dataDir, 'no-interview'), PORT: String(port), JOB_QUEST_FAKE_AGENT: path.join(__dirname, 'fixtures', 'fake-agent.js') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { if ((await fetch(`${base}/api/jobs`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error('server did not start\n' + stderr);
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn(base);
  } finally { child.kill(); }
}

test('settings endpoints round-trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-srv-'));
  await withServer(dir, async (base) => {
    const s = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(s.workbooks.autoDailyCap, 3);
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resume: { autoTailor: false } }) });
    const s2 = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(s2.resume.autoTailor, false);
  });
});

test('GET /api/jobs returns a list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-srv-'));
  await withServer(dir, async (base) => {
    const jobs = await (await fetch(`${base}/api/jobs`)).json();
    assert.ok(Array.isArray(jobs));
  });
});
