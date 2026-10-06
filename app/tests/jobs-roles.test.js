// app/tests/jobs-roles.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRole, splitRoleKey } = require('../lib/jobs/roles');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-roles-'));
  fs.mkdirSync(path.join(dir, 'intel'));
  fs.writeFileSync(path.join(dir, 'intel', '2026-10-01.json'), JSON.stringify({ roles: [
    { company: 'Acme', role: 'Staff SWE', level: 'Staff', location: 'NYC', url: 'https://old', fit: 'old fit' },
  ] }));
  fs.writeFileSync(path.join(dir, 'intel', '2026-10-05.json'), JSON.stringify({ roles: [
    { company: 'Acme', role: 'Staff SWE', level: 'Staff', location: 'NYC', url: 'https://new', fit: 'new fit' },
  ] }));
  fs.writeFileSync(path.join(dir, 'role-tracker.json'), JSON.stringify({ 'Beta|Senior SWE': { stage: 'applied', url: 'https://beta' } }));
  return dir;
}

test('splitRoleKey splits on the first pipe', () => {
  assert.deepEqual(splitRoleKey('Acme|Staff SWE | Platform'), { company: 'Acme', role: 'Staff SWE | Platform' });
});

test('resolveRole prefers the newest intel file', () => {
  const r = resolveRole(setup(), 'Acme|Staff SWE');
  assert.equal(r.url, 'https://new');
  assert.equal(r.source, 'intel');
});

test('resolveRole falls back to the tracker, then the key', () => {
  const dir = setup();
  assert.equal(resolveRole(dir, 'Beta|Senior SWE').source, 'tracker');
  const k = resolveRole(dir, 'Gamma|Eng');
  assert.equal(k.source, 'key');
  assert.equal(k.company, 'Gamma');
  assert.equal(k.url, null);
});
