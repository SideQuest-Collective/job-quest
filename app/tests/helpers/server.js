// app/tests/helpers/server.js
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function withServer(dataDir, fn, extraEnv = {}) {
  // The reservation must close before spawn; retry if another process wins that gap.
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (await serverAttempt(dataDir, fn, extraEnv, attempt < 3)) return;
  }
}

async function serverAttempt(dataDir, fn, extraEnv, canRetry) {
  const port = await reservePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-server-home-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, HOME: home, DATA_DIR: dataDir, INTERVIEW_HOME: path.join(dataDir, 'no-interview'), JOB_QUEST_FAKE_AGENT: path.join(__dirname, '..', 'fixtures', 'fake-agent.js'), ...extraEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  let spawnError;
  child.on('error', (err) => { spawnError = err; });
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (spawnError) throw spawnError;
      if (exited()) {
        if (canRetry) return false;
        throw new Error(`server exited with ${child.exitCode ?? child.signalCode}\n${stderr}`);
      }
      if (stdout.includes(`http://localhost:${port}\n`)) {
        try {
          const response = await fetch(`${base}/api/resume/master`, { signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          if (response.ok && !exited()) break;
        } catch { /* not up yet */ }
      }
      if (Date.now() > deadline) throw new Error(`server did not start\n${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn(base, () => stderr);
    return true;
  } catch (err) {
    err.message = `${err.message}\n${stderr}`.trim();
    throw err;
  } finally {
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

module.exports = { withServer, post: (b) => json('POST', b), put: (b) => json('PUT', b) };
