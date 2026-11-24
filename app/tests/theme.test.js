/*
 * Run: node --test work/jobquest-redesign/tests/theme.test.cjs
 * Dependencies: Node.js built-ins only. Executes the actual shared theme script
 * against synthetic document/storage objects; it never changes browser settings.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/theme.js'), 'utf8');

function themePage({ saved = {}, readFails = false, writeFails = false } = {}) {
  const storage = new Map(Object.entries(saved));
  const attributes = new Map();
  const events = new Map();
  const writes = [];
  const context = {
    document: { documentElement: { setAttribute(name, value) { attributes.set(name, value); } } },
    localStorage: {
      getItem(key) {
        if (readFails) throw Error('Storage is unavailable');
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        if (writeFails) throw Error('Storage quota exceeded');
        writes.push([key, value]);
        storage.set(key, value);
      },
    },
    window: {
      addEventListener(name, listener) {
        if (!events.has(name)) events.set(name, []);
        events.get(name).push(listener);
      },
    },
  };
  vm.runInNewContext(script, context, { filename: 'theme.js' });
  return {
    api: context.window.JobQuestTheme,
    attribute: () => attributes.get('data-theme'),
    writes,
    saved: key => storage.get(key),
    storageEvent(key, newValue) {
      for (const listener of events.get('storage') || []) listener({ key, newValue });
    },
  };
}

function assertTheme(page, expected) {
  assert.equal(page.api.get(), expected, 'Theme API reflects current appearance');
  assert.equal(page.attribute(), expected, 'Document appearance matches theme API');
}

test('starts dark before interaction without writing a preference', () => {
  const page = themePage();
  assertTheme(page, 'dark');
  assert.deepEqual(page.writes, []);
});

test('restores a saved theme and gives it precedence over the legacy workbook preference', () => {
  for (const saved of ['light', 'dark']) {
    const page = themePage({ saved: { 'jobquest.theme': saved, 'workbook.theme': saved === 'light' ? 'dark' : 'light' } });
    assertTheme(page, saved);
    assert.deepEqual(page.writes, [], 'Restoration does not overwrite saved preferences');
  }
});

test('uses valid legacy workbook preference when the current preference is absent or invalid', () => {
  for (const current of [undefined, '', 'sepia', 'LIGHT']) {
    const saved = { 'workbook.theme': 'light' };
    if (current !== undefined) saved['jobquest.theme'] = current;
    const page = themePage({ saved });
    assertTheme(page, 'light');
    assert.deepEqual(page.writes, [], 'Legacy restoration leaves existing data intact');
  }
  assertTheme(themePage({ saved: { 'workbook.theme': 'dark' } }), 'dark');
  assertTheme(themePage({ saved: { 'jobquest.theme': 'sepia', 'workbook.theme': 'blue' } }), 'dark');
});

test('rejects invalid explicit choices while preserving the current appearance and saved value', () => {
  const page = themePage({ saved: { 'jobquest.theme': 'light' } });
  const updates = [];
  page.api.subscribe(value => updates.push(value));
  for (const invalid of [undefined, null, '', 'LIGHT', 'sepia', false, 0, {}]) {
    assert.equal(page.api.set(invalid), 'light');
    assertTheme(page, 'light');
  }
  assert.equal(page.saved('jobquest.theme'), 'light');
  assert.deepEqual(page.writes, []);
  assert.deepEqual(updates, [], 'Rejected choices do not notify subscribers');
});

test('storage read and write failures still allow appearance changes for the current page', () => {
  const page = themePage({ readFails: true, writeFails: true });
  assertTheme(page, 'dark');
  const updates = [];
  page.api.subscribe(value => updates.push(value));
  assert.equal(page.api.set('light'), 'light');
  assertTheme(page, 'light');
  assert.equal(page.api.toggle(), 'dark');
  assertTheme(page, 'dark');
  assert.deepEqual(updates, ['light', 'dark']);
  assert.deepEqual(page.writes, []);

  const writeBlocked = themePage({ saved: { 'jobquest.theme': 'light' }, writeFails: true });
  assertTheme(writeBlocked, 'light');
  writeBlocked.api.toggle();
  assertTheme(writeBlocked, 'dark');
  assert.equal(writeBlocked.saved('jobquest.theme'), 'light', 'Failed persistence does not pretend to update storage');
});

test('toggle persists its choice, notifies subscribers, and honors unsubscribe', () => {
  const page = themePage();
  const first = [], second = [];
  const unsubscribe = page.api.subscribe(value => first.push(value));
  page.api.subscribe(value => second.push(value));
  assert.equal(page.api.toggle(), 'light');
  assertTheme(page, 'light');
  assert.equal(page.saved('jobquest.theme'), 'light');
  assert.deepEqual(first, ['light']);
  assert.deepEqual(second, ['light']);
  unsubscribe();
  unsubscribe();
  assert.equal(page.api.toggle(), 'dark');
  assertTheme(page, 'dark');
  assert.deepEqual(first, ['light'], 'Removed subscriber receives no further updates');
  assert.deepEqual(second, ['light', 'dark']);
  assert.deepEqual(page.writes, [['jobquest.theme', 'light'], ['jobquest.theme', 'dark']]);
});

test('cross-tab storage changes update appearance and subscribers without writing back', () => {
  const page = themePage();
  const updates = [];
  page.api.subscribe(value => updates.push(value));
  page.storageEvent('unrelated.preference', 'light');
  assertTheme(page, 'dark');
  assert.deepEqual(updates, []);

  page.storageEvent('jobquest.theme', 'light');
  assertTheme(page, 'light');
  page.storageEvent('jobquest.theme', 'dark');
  assertTheme(page, 'dark');
  page.storageEvent('jobquest.theme', 'light');
  page.storageEvent('jobquest.theme', 'invalid');
  assertTheme(page, 'dark');
  page.storageEvent('jobquest.theme', 'light');
  page.storageEvent('jobquest.theme', null);
  assertTheme(page, 'dark');
  page.storageEvent('jobquest.theme', 'light');
  page.storageEvent(null, null);
  assertTheme(page, 'dark');
  assert.deepEqual(updates, ['light', 'dark', 'light', 'dark', 'light', 'dark', 'light', 'dark']);
  assert.deepEqual(page.writes, [], 'Cross-tab changes must not echo writes into another storage event');
});
