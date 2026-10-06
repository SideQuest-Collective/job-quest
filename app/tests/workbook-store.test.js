// app/tests/workbook-store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/workbook/store');
const { lintWorkbook, errorsOnly } = require('../lib/workbook/lint');
const { parseContentDir } = require('../lib/workbook/parse');
const { writeKit } = require('./helpers/workbook-fixture');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-')); }
const now = () => new Date('2026-10-05T12:00:00.000Z');

test('workbook JSON writes keep separate payloads when writes interleave', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'meta.json');
  const first = { title: 'First workbook' };
  const second = { title: 'Second workbook' };
  const rename = fs.renameSync;
  const temps = [];
  t.mock.method(fs, 'renameSync', (temp, destination) => {
    temps.push(temp);
    if (temps.length === 1) {
      store.writeJsonAtomic(file, second);
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(second, null, 2));
    }
    rename(temp, destination);
  });
  store.writeJsonAtomic(file, first);
  assert.equal(new Set(temps).size, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(first, null, 2));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['meta.json']);
});

test('createWorkbook writes meta and empty progress with a slug id and collision suffix', () => {
  const dir = tmp();
  const m = store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'] }, now);
  assert.equal(m.id, 'acme-staff-engineer');
  assert.equal(m.title, 'Acme: Staff Engineer');
  assert.deepEqual(m.companyNames, { acme: 'Acme' });
  assert.deepEqual([m.tier, m.status, m.source, m.trigger, m.createdAt], ['screen', 'queued', 'generated', 'manual', '2026-10-05T12:00:00.000Z']);
  assert.ok(fs.existsSync(path.join(store.wbDir(dir, m.id), 'content')));
  assert.equal(store.readProgress(dir, m.id).version, 1);
  assert.equal(store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'] }, now).id, 'acme-staff-engineer-2');
  assert.throws(() => store.createWorkbook(dir, { roleKeys: ['no pipe'] }), /roleKey/);
});

test('list, find, meta round-trip, delete', () => {
  const dir = tmp();
  const a = store.createWorkbook(dir, { roleKeys: ['Acme|Eng'] }, () => new Date('2026-10-01T00:00:00Z'));
  const b = store.createWorkbook(dir, { roleKeys: ['Beta|Eng', 'Beta|Eng II'] }, () => new Date('2026-10-02T00:00:00Z'));
  assert.deepEqual(store.listWorkbooks(dir).map((m) => m.id), [b.id, a.id]);
  assert.equal(store.findByRoleKey(dir, 'Beta|Eng II').id, b.id);
  assert.equal(store.findByRoleKey(dir, 'Gamma|Eng'), null);
  const saved = store.writeMeta(dir, { ...a, status: 'ready' }, now);
  assert.equal(store.readMeta(dir, a.id).status, 'ready');
  assert.equal(saved.updatedAt, '2026-10-05T12:00:00.000Z');
  store.deleteWorkbook(dir, a.id);
  assert.equal(store.readMeta(dir, a.id), null);
  assert.deepEqual(store.listWorkbooks(dir).map((m) => m.id), [b.id]);
});

test('job state and progress round-trip; writeGrades keeps the source', () => {
  const dir = tmp();
  const m = store.createWorkbook(dir, { roleKeys: ['Acme|Eng'] });
  assert.equal(store.readJob(dir, m.id), null);
  store.writeJob(dir, m.id, { runId: 'r1' });
  assert.deepEqual(store.readJob(dir, m.id), { runId: 'r1' });
  store.writeChapterFile(dir, m.id, '01-test.md', '@@chapter id=test\n@@q id=q type=open chapter=test\nQ?');
  store.writeProgress(dir, m.id, { answers: { q: 'hi' } });
  store.writeGrades(dir, m.id, [{ qid: 'q', grade: 'missed', at: '2026-10-05T10:00:00Z', source: 'trainer' }]);
  const p = store.readProgress(dir, m.id);
  assert.equal(p.answers.q, 'hi');
  assert.deepEqual(p.grades.q, { grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'trainer' });
  assert.throws(() => store.writeGrades(dir, 'missing-workbook', []), /not found/);
});

test('viewerContent exposes viewer fields, SD topic ids, and a merged glossary; never tests', () => {
  const dir = tmp();
  const m = store.createWorkbook(dir, { roleKeys: ['Acme|Eng'] });
  writeKit(store.wbDir(dir, m.id), { 'glossary-30-extra.txt': 'Acme :: The company.\n' });
  const c = store.viewerContent(dir, m.id);
  assert.deepEqual(c.chapters.map((x) => [x.id, x.company, x.topic, x.title, x.mins]), [['intro', 'acme', 'Company', 'Acme basics', '4'], ['algo', 'both', 'Algorithms', 'Two pointers', undefined]]);
  assert.deepEqual(c.questions.map((q) => [q.id, q.type, q.diff, q.chapter]), [['intro-1', 'mcq', 1, 'intro'], ['intro-2', 'open', 3, 'intro'], ['algo-1', 'code', 2, 'algo']]);
  assert.equal(c.questions[1].sdTopicId, store.sdTopicId(m.id, 'intro-2'));
  assert.match(c.questions[1].sdTopicId, /^wb-[0-9a-f]{12}$/);
  assert.equal(c.questions[0].sdTopicId, undefined);
  assert.equal('tests' in c.questions[2], false);
  assert.deepEqual(c.glossary.map((g) => [g.t, !!g.nl]), [['Acme', true], ['Fan-out', false], ['heap', true], ['two pointers', false], ['widget', false]]);
});

test('summary combines content and progress', () => {
  const dir = tmp();
  const m = store.createWorkbook(dir, { roleKeys: ['Acme|Eng'] });
  writeKit(store.wbDir(dir, m.id));
  store.writeGrades(dir, m.id, [{ qid: 'intro-2', grade: 'got', at: '2026-10-05T10:00:00Z', source: 'dashboard' }, { qid: 'algo-1', grade: 'partial', at: '2026-10-05T10:00:00Z', source: 'dashboard' }]);
  assert.deepEqual(store.summary(dir, m.id), { readiness: Math.round((100 * (3 + 1)) / 6), graded: 2, total: 3, misses: 1 });
});

test('interview helpers: minimal workbook, lint-clean asked chapter, deduped append, interview grades', () => {
  const dir = tmp();
  const m = store.createMinimalWorkbook(dir, { roleKey: 'Beta|Senior SWE' }, now);
  assert.deepEqual([m.status, m.source, m.trigger], ['ready', 'interview', 'interview']);
  assert.equal(store.createMinimalWorkbook(dir, { roleKey: 'Beta|Senior SWE' }).id, m.id);
  const markup = '@@q id=iv-20261001-1 company=beta topic="Interviews" type=open diff=2 chapter=asked-in-interviews\nHow would you rate-limit an API?\n@@rubric\n- Names token bucket.\n@@answer\nUse a token bucket per client.';
  const first = store.appendChapterQuestions(dir, m.id, { intro: 'From your 2026-10-01 coding round.', questions: [{ id: 'iv-20261001-1', markup }] }, now);
  assert.deepEqual([first.chapterId, first.appended, first.skipped], ['asked-in-interviews', ['iv-20261001-1'], []]);
  const again = store.appendChapterQuestions(dir, m.id, { intro: 'From your coding and system rounds.', questions: [{ id: 'iv-20261001-1', markup }] }, now);
  assert.deepEqual(again.skipped, ['iv-20261001-1']);
  const parsed = parseContentDir(path.join(store.wbDir(dir, m.id), 'content'));
  assert.deepEqual(errorsOnly(lintWorkbook(parsed)), []);
  assert.equal(parsed.questions.length, 1);
  assert.match(parsed.chapters[0].body, /From your coding and system rounds\./);
  assert.doesNotMatch(parsed.chapters[0].body, /2026-10-01 coding round/);
  store.writeGrades(dir, m.id, [{ qid: 'iv-20261001-1', grade: 'missed', at: '2026-10-01T15:00:00Z', source: 'interview' }]);
  assert.equal(store.readProgress(dir, m.id).grades['iv-20261001-1'].source, 'interview');
  assert.throws(() => store.appendChapterQuestions(dir, m.id, { questions: [{ id: 'iv-x', markup: '@@q id=other type=open' }] }), /must start with/);
});

test('P3 entry points: createMinimal, writeChapterFile, recordGrades', () => {
  const dir = tmp();
  const m = store.createMinimal(dir, { roleKey: 'Gamma|Data Engineer', company: 'Gamma', role: 'Data Engineer', source: 'interview' }, now);
  assert.deepEqual([m.id, m.source, m.company], ['gamma-data-engineer', 'interview', 'Gamma']);
  assert.equal(store.findByRoleKey(dir, 'Gamma|Data Engineer').id, m.id);
  store.writeChapterFile(dir, m.id, '99-asked-in-interviews.md', '@@chapter id=asked-in-interviews company=gamma topic="Interviews" title="Asked in your interviews"\n## In plain English\n\nx\n\n## Key takeaways\n\n- y\n');
  assert.equal(store.loadParsed(dir, m.id).chapters[0].id, 'asked-in-interviews');
  assert.throws(() => store.writeChapterFile(dir, m.id, '../escape.md', 'x'), /invalid chapter file name/);
  store.writeChapterFile(dir, m.id, '98-test.md', '@@chapter id=test\n@@q id=iv-1 type=open chapter=test\nQ?');
  store.recordGrades(dir, m.id, [{ qid: 'iv-1', grade: 'partial', at: '2026-10-01T15:00:00Z', source: 'interview' }]);
  assert.equal(store.readProgress(dir, m.id).grades['iv-1'].grade, 'partial');
});

test('isValidId rejects traversal and junk', () => {
  for (const bad of ['..', '../x', 'A', 'a/b', '', 'a'.repeat(91), '.hidden', '-lead']) assert.equal(store.isValidId(bad), false, bad);
  assert.equal(store.isValidId('acme-staff-engineer-2'), true);
  assert.throws(() => store.wbDir('/tmp', '../etc'), /invalid workbook id/);
});

test('recordGrades normalizes equivalent timestamps before merging history', () => {
  const dir = tmp();
  const m = store.createMinimal(dir, { roleKey: 'Acme|Eng' }, now);
  store.writeChapterFile(dir, m.id, '98-test.md', '@@chapter id=test\n@@q id=iv-1 type=open chapter=test\nQ?');
  store.recordGrades(dir, m.id, [{ qid: 'iv-1', grade: 'partial', at: '2026-10-05T12:00:00Z', source: 'interview' }]);
  const { progress: p } = store.recordGrades(dir, m.id, [{ qid: 'iv-1', grade: 'partial', at: '2026-10-05T12:00:00.000Z', source: 'interview' }]);
  const expected = { grade: 'partial', at: '2026-10-05T12:00:00.000Z', source: 'interview' };
  assert.deepEqual(p.history['iv-1'], [expected]);
  assert.deepEqual(p.grades['iv-1'], expected);
  assert.deepEqual(store.readProgress(dir, m.id), p);
});

test('fix round 1: recordGrades validates the full batch and reports rejected entries', () => {
  const dir = tmp();
  const m = store.createMinimal(dir, { roleKey: 'Acme|Eng' });
  writeKit(store.wbDir(dir, m.id));
  const result = store.recordGrades(dir, m.id, [
    { qid: 'intro-1', grade: 'got', at: '2026-10-05T12:00:00Z' },
    { qid: 'intro-2', grade: 'missed', at: 'invalid' },
    { qid: 'algo-1', grade: 'great', at: '2026-10-05T12:00:00Z' },
    { qid: 'missing', grade: 'got', at: '2026-10-05T12:00:00Z' },
    null,
    { qid: 'algo-1', grade: 'partial', at: '2026-10-05T13:00:00Z' },
  ]);
  assert.deepEqual(result.recorded, ['intro-1', 'algo-1']);
  assert.deepEqual(result.rejected.map(r => r.qid), ['intro-2', 'algo-1', 'missing', null]);
  assert.ok(result.rejected.every(r => typeof r.reason === 'string' && r.reason.length));
  assert.equal(result.progress.grades['algo-1'].grade, 'partial');
  assert.deepEqual(store.readProgress(dir, m.id), result.progress);
});
