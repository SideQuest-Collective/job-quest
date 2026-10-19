const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {readLegacyRun} = require('../lib/intel-control/history');

function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-intel-history-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'daily-intel.log');
  fs.writeFileSync(file, content);
  return file;
}

test('only a matching run start and finish establish a historical process outcome', t => {
  const file = fixture(t, '[2026-10-19 09:07:12] === Daily intel run finished (exit 0) ===\n');
  assert.equal(readLegacyRun(file), null);
  fs.appendFileSync(file, '[2026-10-19 10:00:00] === Daily intel run started ===\n');
  assert.equal(readLegacyRun(file).status, 'unknown');
  fs.appendFileSync(file, '[2026-10-19 10:01:00] === Daily intel run finished (exit 1) ===\n');
  assert.equal(readLegacyRun(file).status, 'failed');
  fs.appendFileSync(file, '[2026-10-19 11:00:00] === Daily intel run started ===\n');
  assert.equal(readLegacyRun(file).status, 'unknown');
  assert.equal(readLegacyRun(file).finishedAt, null);
});

test('history never relays arbitrary runtime summaries or error output', t => {
  const file = fixture(t, '[2026-10-19 09:00:00] === Daily intel run started ===\n[2026-10-19 09:01:00] Summary: private recruiter content\n[2026-10-19 09:01:00] stderr: private recruiter content\n[2026-10-19 09:01:00] === Daily intel run finished (exit 1) ===\n');
  const result = readLegacyRun(file);
  assert.equal(result.summary, null);
  assert.ok(!JSON.stringify(result).includes('private recruiter content'));
});

test('bounded tail parsing discards a partial first line and keeps the latest run', t => {
  const prefix = '[2026-10-01 09:00:00] === Daily intel run started ===\n' + 'x'.repeat(140000);
  const file = fixture(t, prefix + '\n[2026-10-19 09:00:00] === Daily intel run started ===\n[2026-10-19 09:01:00] === Daily intel run finished (exit 0) ===\n');
  assert.equal(readLegacyRun(file).status, 'completed');
  assert.equal(new Date(readLegacyRun(file).startedAt).getDate(), 19);
  assert.equal(readLegacyRun(file + '.missing'), null);
});
