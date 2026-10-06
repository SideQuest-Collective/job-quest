const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const intel = html.slice(html.indexOf('function Intel('), html.indexOf('// Ensure tracker entry exists', html.indexOf('function Intel(')));

test('tracker refetches on focus and visibility with pending-save guards and listener cleanup', () => {
  assert.match(intel, /window\.addEventListener\('focus', refreshTracker\)/);
  assert.match(intel, /document\.addEventListener\('visibilitychange', refreshTracker\)/);
  assert.match(intel, /window\.removeEventListener\('focus', refreshTracker\)/);
  assert.match(intel, /document\.removeEventListener\('visibilitychange', refreshTracker\)/);
  const refresh = intel.slice(intel.indexOf('const refreshTracker ='), intel.indexOf("window.addEventListener('focus'"));
  assert.match(refresh, /if \([^\n]*saveTimer\.current[^\n]*\) return/);
  assert.match(refresh, /document\.visibilityState/);
  assert.match(refresh, /api\.get\('\/api\/role-tracker'\)/);
  assert.match(refresh, /!saveTimer\.current[\s\S]*setRoleTracker/);
  const save = intel.slice(intel.indexOf('const saveTracker ='));
  assert.match(save, /await api\.post\('\/api\/role-tracker', updated\)/);
  assert.match(save, /finally[\s\S]*saveTimer\.current = null/);
});

test('focus refresh skips pending saves and discards responses overtaken by edits or unmount', async () => {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const saveTimer = { current: null }, trackerRevision = { current: 0 };
  const requests = [], updates = [];
  let cleanup;
  const effect = intel.slice(intel.indexOf('  useEffect(() => {'), intel.indexOf('  // Build role list'));
  vm.runInNewContext(effect, {
    window, document, saveTimer, trackerRevision, console,
    useEffect: fn => { cleanup = fn(); },
    setRoleTracker: value => updates.push(value),
    api: { get: url => {
      assert.equal(url, '/api/role-tracker');
      return new Promise(resolve => requests.push(resolve));
    } },
  });
  const focus = () => window.dispatchEvent(new Event('focus'));
  const visible = () => document.dispatchEvent(new Event('visibilitychange'));
  saveTimer.current = 1;
  focus(); visible();
  assert.equal(requests.length, 0);
  saveTimer.current = null;
  document.visibilityState = 'hidden';
  focus(); visible();
  assert.equal(requests.length, 0);
  document.visibilityState = 'visible';
  visible();
  requests[0]({ fresh: true });
  await Promise.resolve();
  assert.deepEqual(updates, [{ fresh: true }]);
  focus();
  trackerRevision.current++;
  requests[1]({ stale: true });
  await Promise.resolve();
  assert.equal(updates.length, 1);
  focus();
  saveTimer.current = 2;
  requests[2]({ pending: true });
  await Promise.resolve();
  assert.equal(updates.length, 1);
  saveTimer.current = null;
  focus();
  cleanup();
  requests[3]({ unmounted: true });
  await Promise.resolve();
  focus(); visible();
  assert.equal(requests.length, 4);
  assert.equal(updates.length, 1);
});
