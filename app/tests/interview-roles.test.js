// app/tests/interview-roles.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listRolesForCompany, companyMatches, isKnownRole } = require('../lib/interview/roles');
const { makeEnv, seedTracker, seedWorkbook } = require('./helpers/interview-env');

function setup(t) {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedTracker(dataDir, {
    'Acme Capital|Software Engineer': { stage: 'applied', timeline: [{ date: '2026-09-10T00:00:00.000Z', event: 'Applied' }] },
    'Acme Capital|Data Engineer': { stage: 'phone-screen', timeline: [{ date: '2026-09-01T00:00:00.000Z', event: 'a' }, { date: '2026-09-20T00:00:00.000Z', event: 'b' }] },
    'Two Sigma|SWE': { stage: 'onsite', timeline: [] },
    'Acmeish|PM': { stage: 'applied', timeline: [{ date: '2026-09-30T00:00:00.000Z', event: 'x' }] },
  });
  fs.writeFileSync(path.join(dataDir, 'role-actions.json'), JSON.stringify({ saved: ['Acme Capital|Intern'], skipped: ['Acme Capital|Skipped'], applied: [] }));
  return dataDir;
}

test('companyMatches is case-insensitive and allows a leading-word query', () => {
  assert.equal(companyMatches('Two Sigma', 'two'), true);
  assert.equal(companyMatches('Two Sigma', 'TWO SIGMA'), true);
  assert.equal(companyMatches('Two Sigma', 'sigma'), false);
  assert.equal(companyMatches('Acmeish', 'acme'), false);
});

test('companyMatches rejects empty and symbol-only queries on its own', () => {
  for (const query of ['', '   ', '!!!', null, undefined]) {
    assert.equal(companyMatches('Role Models', query), false, `query: ${String(query)}`);
  }
});

test('non-string saved and applied entries are ignored', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'role-actions.json'), JSON.stringify({
    saved: [null, false, 12, {}, [], 'Acme|Saved'],
    applied: [null, true, 34, {}, [], 'Acme|Applied'],
  }));
  assert.deepEqual(listRolesForCompany(dataDir, 'acme').map((row) => [row.roleKey, row.stage]), [
    ['Acme|Applied', 'applied'], ['Acme|Saved', 'saved'],
  ]);
});

test('equal activity uses code-unit role order with Zeta before alpha', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const timeline = [{ date: '2026-09-01T00:00:00.000Z', event: 'Applied' }];
  seedTracker(dataDir, {
    'Acme|alpha': { stage: 'applied', timeline },
    'Acme|Zeta': { stage: 'applied', timeline },
  });
  assert.deepEqual(listRolesForCompany(dataDir, 'Acme').map((row) => row.roleKey), ['Acme|Zeta', 'Acme|alpha']);
});

test('an applied-only role falls back to the applied stage without a tracker entry', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'role-actions.json'), JSON.stringify({ saved: [], applied: ['Acme|SWE'] }));
  assert.deepEqual(listRolesForCompany(dataDir, 'Acme'), [{
    roleKey: 'Acme|SWE', company: 'Acme', role: 'SWE', stage: 'applied', hasWorkbook: false, hasTailoredResume: false,
  }]);
});

test('lists matching roles newest tracker activity first, with stages', (t) => {
  const dataDir = setup(t);
  const rows = listRolesForCompany(dataDir, 'acme');
  assert.deepEqual(rows.map((r) => [r.roleKey, r.stage]), [
    ['Acme Capital|Data Engineer', 'phone-screen'],
    ['Acme Capital|Software Engineer', 'applied'],
    ['Acme Capital|Intern', 'saved'],
  ]);
  assert.deepEqual(listRolesForCompany(dataDir, 'ACME CAPITAL').map((r) => r.roleKey), rows.map((r) => r.roleKey));
  assert.deepEqual(listRolesForCompany(dataDir, 'two').map((r) => r.roleKey), ['Two Sigma|SWE']);
  assert.deepEqual(listRolesForCompany(dataDir, 'nobody'), []);
});

test('reports hasWorkbook and hasTailoredResume', (t) => {
  const dataDir = setup(t);
  seedWorkbook(dataDir, 'Acme Capital|Software Engineer');
  const d = path.join(dataDir, 'resume', 'tailored', 'acme-capital-data-engineer');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ roleKeys: ['Acme Capital|Data Engineer'], status: 'below-target' }));
  const rows = Object.fromEntries(listRolesForCompany(dataDir, 'acme').map((r) => [r.roleKey, r]));
  assert.deepEqual(rows['Acme Capital|Software Engineer'], { roleKey: 'Acme Capital|Software Engineer', company: 'Acme Capital', role: 'Software Engineer', stage: 'applied', hasWorkbook: true, hasTailoredResume: false });
  assert.equal(rows['Acme Capital|Data Engineer'].hasTailoredResume, true);
  assert.equal(rows['Acme Capital|Data Engineer'].hasWorkbook, false);
});

test('an empty or symbol-only company is an input error', (t) => {
  const dataDir = setup(t);
  assert.throws(() => listRolesForCompany(dataDir, ''), (e) => e.code === 'INPUT');
  assert.throws(() => listRolesForCompany(dataDir, '!!!'), (e) => e.code === 'INPUT');
});

test('isKnownRole accepts tracker, saved, and intel roles only', (t) => {
  const dataDir = setup(t);
  fs.mkdirSync(path.join(dataDir, 'intel'));
  fs.writeFileSync(path.join(dataDir, 'intel', '2026-10-05.json'), JSON.stringify({ roles: [{ company: 'Gamma', role: 'Eng' }] }));
  assert.equal(isKnownRole(dataDir, 'Two Sigma|SWE'), true);
  assert.equal(isKnownRole(dataDir, 'Acme Capital|Intern'), true);
  assert.equal(isKnownRole(dataDir, 'Gamma|Eng'), true);
  assert.equal(isKnownRole(dataDir, 'Nobody|Role'), false);
});
