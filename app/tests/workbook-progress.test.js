// app/tests/workbook-progress.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyProgress, normalizeProgress, mergeProgress, readiness, misses, summarize } = require('../lib/workbook/progress');

const Q = [{ id: 'a', diff: 1 }, { id: 'b', diff: 2 }, { id: 'c', diff: 3 }];

test('empty and garbage progress normalize to the empty shape', () => {
  assert.deepEqual(normalizeProgress(null), emptyProgress());
  assert.deepEqual(normalizeProgress('x'), emptyProgress());
});

test('merge: answers per qid, grades validated and normalized, history appended', () => {
  let p = mergeProgress(null, { answers: { a: 'one' }, grades: { a: { grade: 'got', at: '2026-10-05T10:00:00Z' }, b: { grade: 'great', at: 'x' } } });
  p = mergeProgress(p, { answers: { b: 'two' }, grades: { a: { grade: 'partial', at: '2026-10-05T11:00:00.000Z', source: 'trainer' } } });
  assert.deepEqual(p.answers, { a: 'one', b: 'two' });
  assert.deepEqual(p.grades, { a: { grade: 'partial', at: '2026-10-05T11:00:00.000Z', source: 'trainer' } });
  assert.deepEqual(p.history.a.map((h) => h.grade), ['got', 'partial']);
  assert.equal(p.history.a[0].source, 'dashboard');
});

test('an older grade never replaces a newer one but is kept in history', () => {
  let p = mergeProgress(null, { grades: { a: { grade: 'got', at: '2026-10-05T12:00:00.000Z' } } });
  p = mergeProgress(p, { grades: { a: { grade: 'missed', at: '2026-10-04T09:00:00.000Z', source: 'dashboard' } } });
  assert.equal(p.grades.a.grade, 'got');
  assert.deepEqual(p.history.a.map((h) => [h.grade, h.at]), [['missed', '2026-10-04T09:00:00.000Z'], ['got', '2026-10-05T12:00:00.000Z']]);
});

test('re-sending the same grade does not duplicate history', () => {
  const g = { grades: { a: { grade: 'got', at: '2026-10-05T12:00:00.000Z' } } };
  const p = mergeProgress(mergeProgress(null, g), g);
  assert.equal(p.history.a.length, 1);
});

test('ui merges per top-level key and lastChapter is replaced', () => {
  let p = mergeProgress(null, { ui: { read: { c1: true }, flag: { a: true } }, lastChapter: 'c1' });
  p = mergeProgress(p, { ui: { read: { c2: true } }, lastChapter: 'c2' });
  assert.deepEqual(p.ui, { read: { c2: true }, flag: { a: true } });
  assert.equal(p.lastChapter, 'c2');
});

test('readiness weights by difficulty, partial counts half', () => {
  const p = mergeProgress(null, { grades: { a: { grade: 'got', at: '2026-10-05T10:00:00Z' }, c: { grade: 'partial', at: '2026-10-05T10:00:00Z' } } });
  assert.equal(readiness(Q, p), Math.round((100 * (1 + 1.5)) / 6));
  assert.equal(readiness([], p), 0);
});

test('misses are partial/missed ordered by grade time then qid, unknown qids ignored', () => {
  const p = mergeProgress(null, { grades: {
    c: { grade: 'missed', at: '2026-10-05T10:00:00Z' },
    b: { grade: 'partial', at: '2026-10-05T10:00:00Z' },
    a: { grade: 'missed', at: '2026-10-04T10:00:00Z' },
    zz: { grade: 'missed', at: '2026-10-01T10:00:00Z' },
  } });
  assert.deepEqual(misses(Q, p).map((m) => m.qid), ['a', 'b', 'c']);
  assert.deepEqual(summarize(Q, p), { readiness: Math.round((100 * 1) / 6), graded: 3, total: 3, misses: 3 });
});

test('re-sent grade with a different source is not duplicated', () => {
  const T = '2026-10-05T12:00:00.000Z';
  let p = mergeProgress(null, { grades: { a: { grade: 'missed', at: T, source: 'trainer' } } });
  p = mergeProgress(p, { grades: { a: { grade: 'missed', at: T, source: 'dashboard' } } });
  assert.equal(p.history.a.length, 1);
  assert.equal(p.history.a[0].source, 'trainer');
  assert.equal(p.grades.a.source, 'trainer');
});

test('an equal-time grade never replaces the current grade but is kept in history', () => {
  const T = '2026-10-05T12:00:00.000Z';
  let p = mergeProgress(null, { grades: { a: { grade: 'got', at: T, source: 'trainer' } } });
  p = mergeProgress(p, { grades: { a: { grade: 'missed', at: T, source: 'dashboard' } } });
  assert.deepEqual(p.grades.a, { grade: 'got', at: T, source: 'trainer' });
  assert.deepEqual(p.history.a.map((h) => h.grade), ['got', 'missed']);
});
