const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveDraft, registerDraftRoutes, readProgress } = require('../lib/codelab/drafts');
function setup(t, initial) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-code-drafts-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'problems', 'progress.json');
  if (initial !== undefined) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial)); }
  const options = { dataDir, getProblems: () => ({ problems: [{ id: 'one' }, { id: 'two' }, { id: 'wb-code-123abc' }] }) };
  return { options, file, save: (id, body) => saveDraft(options, id, body), read: () => readProgress(dataDir) };
}
test('per-problem save migrates legacy revision lazily and preserves every other progress field', t => {
  const original = { solved: { two: { solvedAt: '2026-10-09', attempts: 4 } }, bookmarked: ['two'], savedCode: { one: 'old', two: 'keep me' }, history: ['keep history'], preferences: { language: 'python' } };
  const h = setup(t, original);
  assert.deepEqual(h.save('one', { code: 'new', expectedRevision: 0 }), { code: 'new', revision: 1 });
  assert.deepEqual(h.read(), { ...original, savedCode: { ...original.savedCode, one: 'new' }, draftRevisions: { one: 1 } });
});
test('two devices editing the same revision conflict without changing the file and receive authoritative text', t => {
  const h = setup(t);
  h.save('one', { code: 'device A', expectedRevision: 0 });
  const before = fs.readFileSync(h.file, 'utf8');
  assert.throws(() => h.save('one', { code: 'device B', expectedRevision: 0 }), error => {
    assert.equal(error.status, 409); assert.deepEqual(error.current, { code: 'device A', revision: 1 }); return true;
  });
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.deepEqual(h.save('one', { code: 'merged', expectedRevision: 1 }), { code: 'merged', revision: 2 });
});
test('independent problem writes preserve both drafts and revisions, including intentionally empty code', t => {
  const h = setup(t);
  h.save('one', { code: 'A', expectedRevision: 0 }); h.save('two', { code: 'B', expectedRevision: 0 });
  h.save('one', { code: '', expectedRevision: 1 });
  assert.deepEqual(h.read().savedCode, { one: '', two: 'B' });
  assert.deepEqual(h.read().draftRevisions, { one: 2, two: 1 });
  assert.equal(h.save('wb-code-123abc', { code: 'Workbook code', expectedRevision: 0 }).revision, 1);
});
test('unknown/prototype/path IDs and invalid request keys cannot create or overwrite progress', t => {
  const h = setup(t);
  for (const id of ['unknown', '__proto__', 'constructor', 'prototype', '../one', '/one', '']) assert.throws(() => h.save(id, { code: 'bad', expectedRevision: 0 }));
  for (const body of [null, [], {}, { code: '', expectedRevision: -1 }, { code: '', expectedRevision: 0.5 }, { code: 7, expectedRevision: 0 }, { code: '', expectedRevision: '0' }, { code: '', expectedRevision: 0, solved: {} }, { code: 'x'.repeat(1000001), expectedRevision: 0 }]) assert.throws(() => h.save('one', body));
  assert.equal(fs.existsSync(h.file), false);
});
test('corrupt saved progress is never replaced with a new blank record', t => {
  for (const initial of ['invalid json', 'null', '[]', '{"savedCode":[]}', '{"savedCode":{"one":42}}', '{"draftRevisions":{"one":-1}}']) {
    const h = setup(t, initial);
    assert.throws(() => h.save('one', { code: 'new', expectedRevision: 0 }), { status: 500 });
    assert.equal(fs.readFileSync(h.file, 'utf8'), initial);
  }
});
test('failed atomic replacement leaves original file and removes temporary write', t => {
  const h = setup(t, { savedCode: { one: 'before' }, solved: { two: {} } });
  const before = fs.readFileSync(h.file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' }); });
  assert.throws(() => h.save('one', { code: 'after', expectedRevision: 0 }), /Disk unavailable/);
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ['progress.json']);
});
test('PATCH route exposes revision and safe conflict response without leaking write failures', t => {
  const h = setup(t); let handler;
  registerDraftRoutes({ patch(route, callback) { assert.equal(route, '/api/problems/:id/draft'); handler = callback; } }, h.options);
  function request(body) { let status = 200, json; handler({ params: { id: 'one' }, body }, { status(value) { status = value; return this; }, json(value) { json = value; } }); return { status, json }; }
  assert.deepEqual(request({ code: 'first', expectedRevision: 0 }), { status: 200, json: { code: 'first', revision: 1 } });
  const conflict = request({ code: 'second', expectedRevision: 0 });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'first'); assert.equal(conflict.json.revision, 1);
  assert.deepEqual(conflict.json.current, { code: 'first', revision: 1 });
  t.mock.method(fs, 'renameSync', () => { throw new Error('private filesystem path'); });
  const failed = request({ code: 'new', expectedRevision: 1 }); assert.equal(failed.status, 500); assert.doesNotMatch(failed.json.error, /private filesystem/);
});
