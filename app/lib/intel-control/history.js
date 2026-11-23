const fs = require('fs');

// Older runners wrote only this log. Read a bounded tail, and expose execution
// metadata rather than runtime output (which can contain private source content).
function readLegacyRun(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - 131072);
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const lines = buffer.toString('utf8').split('\n');
    if (offset) lines.shift();
    let run = null;
    for (const line of lines) {
      const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.*)$/.exec(line);
      if (!match) continue;
      const timestamp = new Date(match[1].replace(' ', 'T'));
      if (Number.isNaN(timestamp.getTime())) continue;
      if (match[2] === '=== Daily intel run started ===') {
        run = { status: 'unknown', source: 'legacy-log', trigger: null, startedAt: timestamp.toISOString(), finishedAt: null, summary: null, reason: 'This run has no recorded finish. Check the local Intel log before retrying.' };
      }
      if (!run) continue;
      // Never relay an arbitrary agent summary from a historical log.
      const summary = /^Summary: (Done: \d+ roles, \d+ quiz questions, \d+ tasks, \d+ new problems)$/.exec(match[2]);
      if (summary) run.summary = summary[1];
      const finish = /^=== Daily intel run finished \(exit (\d+)\) ===$/.exec(match[2]);
      if (finish) {
        const exitCode = Number(finish[1]);
        run = { ...run, status: exitCode === 0 ? 'completed' : 'failed', finishedAt: timestamp.toISOString(), exitCode, reason: exitCode === 0 ? 'The native runner exited successfully. This older log does not verify each output.' : 'The native runner exited with an error. Check the local Intel log.' };
      }
    }
    return run;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { readLegacyRun };
