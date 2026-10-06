// app/tests/jobs-settings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSettings, writeSettings, DEFAULT_SETTINGS } = require('../lib/jobs/settings');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jq-settings-')); }

test('readSettings returns defaults when file is missing', () => {
  const s = readSettings(tmp());
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.equal(s.workbooks.autoDailyCap, 3);
  assert.equal(s.resume.autoDailyCap, 5);
  assert.equal(s.workbooks.autoBuild, true);
  assert.equal(s.resume.autoTailor, true);
});

test('writeSettings deep-merges and persists', () => {
  const dir = tmp();
  writeSettings(dir, { workbooks: { autoBuild: false } });
  const s = readSettings(dir);
  assert.equal(s.workbooks.autoBuild, false);
  assert.equal(s.workbooks.autoDailyCap, 3);
  assert.equal(s.resume.autoTailor, true);
});

test('readSettings tolerates a corrupt file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{nope');
  assert.deepEqual(readSettings(dir), DEFAULT_SETTINGS);
});
