// Backstop: ingest finished sessions the /interview skill did not hand over (startup + every 10 minutes).
// Only folders with both session.json and debrief.md; a skeleton debrief younger than SETTLE_MS is skipped
// because the skill is still writing the scorecard. Never reads ~/.interview/live/.
const fs = require('fs');
const path = require('path');
const { PLACEHOLDER, assertFolderName } = require('./contract');
const { ingestSession } = require('./ingest');

const SETTLE_MS = 30 * 60 * 1000;

function eligibleFolders(interviewHome, { now = () => new Date(), settleMs = SETTLE_MS } = {}) {
  const root = path.join(interviewHome, 'sessions');
  if (!fs.existsSync(root)) return [];
  const realRoot = fs.realpathSync(root);
  return fs.readdirSync(root).sort().filter((name) => {
    try { assertFolderName(name); } catch { return false; }
    const dir = path.join(root, name);
    const debrief = path.join(dir, 'debrief.md');
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        const relative = path.relative(realRoot, fs.realpathSync(dir));
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
        if (!fs.statSync(dir).isDirectory()) return false;
      } else if (!stat.isDirectory()) return false;
      if (!fs.existsSync(path.join(dir, 'session.json')) || !fs.existsSync(debrief)) return false;
      const fresh = now().getTime() - fs.statSync(debrief).mtimeMs < settleMs;
      return !(fresh && fs.readFileSync(debrief, 'utf-8').includes(PLACEHOLDER));
    } catch {
      return false;
    }
  });
}

async function scanOnce({ dataDir, interviewHome, now = () => new Date(), runAgentFn, log = () => {} }) {
  const results = [];
  for (const folder of eligibleFolders(interviewHome, { now })) {
    try {
      const r = await ingestSession({ dataDir, interviewHome, folder, now, runAgentFn, lockWaitMs: 0 });
      results.push({ folder, status: r.status });
      if (r.status === 'ingested') log(`[interview] ${r.summary}`);
    } catch (err) {
      results.push({ folder, error: err.message });
      log(`[interview] ${folder}: ${err.message}`);
    }
  }
  return results;
}

function startScanner({ dataDir, interviewHome, intervalMs = 600000, now, runAgentFn, log = (m) => console.log(m) }) {
  const printed = new Set();
  const once = (m) => { if (!printed.has(m)) { printed.add(m); log(m); } };
  let running = null;
  const runNow = () => {
    if (!running) {
      running = scanOnce({ dataDir, interviewHome, now, runAgentFn, log: once })
        .catch((err) => { once(`[interview] scan failed: ${err.message}`); return []; })
        .finally(() => { running = null; });
    }
    return running;
  };
  const timer = setInterval(runNow, intervalMs);
  if (timer.unref) timer.unref();
  runNow();
  return { runNow, stop: () => clearInterval(timer), isRunning: () => running !== null };
}

module.exports = { SETTLE_MS, eligibleFolders, scanOnce, startScanner };
