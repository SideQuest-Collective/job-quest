// app/lib/jobs/runner.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'skill', 'bin', 'run-agent.sh');

function runAgent({ agent, prompt, cwd, profile, timeoutMs, logFile, env = {} }) {
  fs.mkdirSync(cwd, { recursive: true });
  const promptFile = path.join(cwd, `.agent-${agent}.prompt.md`);
  fs.writeFileSync(promptFile, prompt);
  const fake = process.env.JOB_QUEST_FAKE_AGENT;
  const [cmd, args] = fake
    ? [process.execPath, [fake, agent, promptFile, cwd]]
    : ['bash', [SCRIPT, profile, promptFile, cwd]];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (logFile) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] agent=${agent} profile=${profile} code=${code} signal=${signal} timedOut=${timedOut} ms=${durationMs}\n--- stdout\n${stdout.slice(-4000)}\n--- stderr\n${stderr.slice(-4000)}\n`);
      }
      resolve({ ok: code === 0 && !timedOut, code, signal, timedOut, stdout, stderr, durationMs });
    });
  });
}

module.exports = { runAgent };
