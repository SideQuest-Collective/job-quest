// Count fake-agent invocations per agent name from <dir>/.fake/.calls.log.
// Returns the same { agent: count } shape the old .calls.json held.
const fs = require('fs');
const path = require('path');

function readFakeCalls(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, '.fake', '.calls.log'), 'utf-8'); } catch { return {}; }
  const out = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const agent = line.split('\t')[0];
    out[agent] = (out[agent] || 0) + 1;
  }
  return out;
}

module.exports = { readFakeCalls };
