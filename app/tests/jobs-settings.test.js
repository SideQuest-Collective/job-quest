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
  assert.equal(s.workbooks.autoBuild, true);
  assert.equal(s.resume, undefined, 'resume tailoring has no automatic settings');
});

test('writeSettings deep-merges and persists', () => {
  const dir = tmp();
  writeSettings(dir, { workbooks: { autoBuild: false } });
  const s = readSettings(dir);
  assert.equal(s.workbooks.autoBuild, false);
  assert.equal(s.workbooks.autoDailyCap, 3);
  assert.equal(s.resume, undefined);
});

test('a legacy resume.autoTailor setting is dropped on read and not rewritten', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ workbooks: { autoBuild: false }, resume: { autoTailor: true, autoDailyCap: 9 } }));
  assert.deepEqual(readSettings(dir), { workbooks: { autoBuild: false, autoDailyCap: 3 } });
  writeSettings(dir, { workbooks: { autoDailyCap: 4 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')), { workbooks: { autoBuild: false, autoDailyCap: 4 } });
});

test('readSettings tolerates a corrupt file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{nope');
  assert.deepEqual(readSettings(dir), DEFAULT_SETTINGS);
});
