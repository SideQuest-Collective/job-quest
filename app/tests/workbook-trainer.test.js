// app/tests/workbook-trainer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { srsFromHistory } = require('../lib/workbook/srs');
const trainer = require('../lib/workbook/trainer');
const store = require('../lib/workbook/store');
const { writeKit } = require('./helpers/workbook-fixture');

const CLI = path.resolve(__dirname, '..', '..', 'skill', 'bin', 'trainer-pick.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-trainer-'));
const at = (iso) => () => new Date(iso);
const H = (grade, iso) => ({ grade, at: iso, source: 'dashboard' });
const questions = (dir) => store.readJsonFile(path.join(dir, 'trainer', 'questions.json'), []);
const saveQuestions = (dir, qs) => store.writeJsonAtomic(path.join(dir, 'trainer', 'questions.json'), qs);

function rig() {
  const dir = tmp();
  const m = store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'], status: 'ready' });
  writeKit(store.wbDir(dir, m.id));
  return { dir, m };
}

test('srs: a miss is due in 1 day; got moves to 3 then 7 days, then retires; a miss resets', () => {
  assert.equal(srsFromHistory([]), null);
  assert.equal(srsFromHistory([H('got', '2026-10-01T10:00:00.000Z')]), null);
  const h = [H('missed', '2026-10-01T10:00:00.000Z')];
  assert.deepEqual(srsFromHistory(h), { stage: 0, dueAt: '2026-10-02T10:00:00.000Z', lastGradeAt: '2026-10-01T10:00:00.000Z', retired: false });
  h.push(H('got', '2026-10-02T12:00:00.000Z'));
  assert.deepEqual([srsFromHistory(h).stage, srsFromHistory(h).dueAt], [1, '2026-10-05T12:00:00.000Z']);
  h.push(H('got', '2026-10-05T13:00:00.000Z'));
  assert.deepEqual([srsFromHistory(h).stage, srsFromHistory(h).dueAt], [2, '2026-10-12T13:00:00.000Z']);
  h.push(H('got', '2026-10-12T14:00:00.000Z'));
  assert.deepEqual([srsFromHistory(h).retired, srsFromHistory(h).dueAt], [true, null]);
  const reset = [H('missed', '2026-10-01T10:00:00.000Z'), H('got', '2026-10-02T10:00:00.000Z'), H('partial', '2026-10-03T10:00:00.000Z')];
  assert.deepEqual([srsFromHistory(reset).stage, srsFromHistory(reset).dueAt], [0, '2026-10-04T10:00:00.000Z']);
});

test('nothing is sent until a miss is due; then the workbook question is recorded verbatim', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [{ qid: 'intro-2', grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' }]);
  assert.deepEqual(trainer.pickWorkbookQuestion(dir, { now: at('2026-10-06T09:59:00.000Z') }), { picked: false, reason: 'nothing-due' });
  const r = trainer.pickWorkbookQuestion(dir, { now: at('2026-10-06T10:00:00.000Z') });
  assert.equal(r.picked, true);
  assert.deepEqual([r.record.source, r.record.workbookId, r.record.qid, r.record.category, r.record.status], ['workbook', m.id, 'intro-2', 'system-design', 'pending']);
  assert.ok(r.message.startsWith('🎯 Interview Trainer — Acme: Staff Engineer (workbook review)\n\nDesign a widget feed.'));
  assert.equal(r.record.rubric, '- Mentions fan-out on write.');
  assert.equal(questions(dir).length, 1);
  assert.equal(store.readJsonFile(path.join(dir, 'trainer', 'workbook-srs.json'), {})[`${m.id}:intro-2`].stage, 0);
});

test('never twice in a row, never while the same item is still open', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [{ qid: 'intro-2', grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' }]);
  const now = at('2026-10-07T10:00:00.000Z');
  assert.equal(trainer.pickWorkbookQuestion(dir, { now }).picked, true);
  assert.deepEqual(trainer.pickWorkbookQuestion(dir, { now }), { picked: false, reason: 'recent-workbook-question' });
  const qs = questions(dir);
  qs.push({ id: 'tq_1', status: 'answered' });
  saveQuestions(dir, qs);
  assert.deepEqual(trainer.pickWorkbookQuestion(dir, { now }), { picked: false, reason: 'recent-workbook-question' });
  qs.push({ id: 'tq_2', status: 'answered' });
  saveQuestions(dir, qs);
  assert.deepEqual(trainer.pickWorkbookQuestion(dir, { now }), { picked: false, reason: 'nothing-due' });
  qs[0].status = 'skipped';
  saveQuestions(dir, qs);
  assert.equal(trainer.pickWorkbookQuestion(dir, { now }).record.qid, 'intro-2');
});

test('the earliest dueAt wins; ties go to key order', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [
    { qid: 'intro-1', grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' },
    { qid: 'algo-1', grade: 'partial', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' },
  ]);
  assert.equal(trainer.pickWorkbookQuestion(dir, { now: at('2026-10-08T00:00:00.000Z') }).record.qid, 'algo-1');
  const { dir: dir2, m: m2 } = rig();
  store.writeGrades(dir2, m2.id, [
    { qid: 'algo-1', grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' },
    { qid: 'intro-1', grade: 'missed', at: '2026-10-05T09:00:00.000Z', source: 'dashboard' },
  ]);
  assert.equal(trainer.pickWorkbookQuestion(dir2, { now: at('2026-10-08T00:00:00.000Z') }).record.qid, 'intro-1');
});

test('gradeMcqReply accepts letters, punctuation, and option text', () => {
  const ch = [{ letter: 'A', text: 'Widgets' }, { letter: 'B', text: 'Gadgets' }, { letter: 'C', text: 'Gizmos' }];
  const cases = [['b', 1], ['B.', 1], ['(c)', 2], ['B) gadgets', 1], ['  gadgets! ', 1], ['"Widgets"', 0], ['d', -1], ['I think B', -1], ['', -1]];
  for (const [reply, want] of cases) assert.equal(trainer.gradeMcqReply(ch, reply), want, reply);
});

test('a workbook MCQ reply is graded by code and written back with source trainer', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [{ qid: 'intro-1', grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' }]);
  const pick = trainer.pickWorkbookQuestion(dir, { now: at('2026-10-06T10:00:00.000Z') });
  const correct = pick.record.choices.find((c) => c.correct);
  assert.match(pick.message, new RegExp(`${correct.letter}\\) Widgets`));
  const now = at('2026-10-06T10:05:00.000Z');
  const unsure = trainer.handleMcqReply(dir, 'maybe?', { now });
  assert.equal(unsure.handled, true);
  assert.match(unsure.text, /^❓ Reply with a letter from A to C/);
  const graded = trainer.handleMcqReply(dir, `${correct.letter.toLowerCase()})`, { now });
  assert.deepEqual([graded.handled, graded.grade], [true, 'got']);
  assert.match(graded.text, /^🏁 Correct/);
  assert.deepEqual(store.readProgress(dir, m.id).grades['intro-1'], { grade: 'got', at: '2026-10-06T10:05:00.000Z', source: 'trainer' });
  assert.equal(questions(dir)[0].status, 'answered');
  assert.equal(store.readJsonFile(path.join(dir, 'trainer', 'workbook-srs.json'), {})[`${m.id}:intro-1`].stage, 1);
  assert.match(trainer.handleMcqReply(dir, 'a', { now }).text, /already graded/);
  saveQuestions(dir, [...questions(dir), { id: 'tq_x', status: 'pending', question: 'normal' }]);
  assert.deepEqual(trainer.handleMcqReply(dir, 'a', { now }), { handled: false });
});

test('recordTrainerGrade writes the first-answer grade exactly once', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [{ qid: 'intro-2', grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' }]);
  const { id } = trainer.pickWorkbookQuestion(dir, { now: at('2026-10-06T10:00:00.000Z') });
  const qs = questions(dir);
  Object.assign(qs[0], { status: 'in-progress', initialEvaluation: { score: 6, grade: 'partial' } });
  saveQuestions(dir, qs);
  const now = at('2026-10-06T11:00:00.000Z');
  assert.deepEqual(trainer.recordTrainerGrade(dir, id, { now }), { recorded: true, grade: 'partial' });
  assert.deepEqual(store.readProgress(dir, m.id).grades['intro-2'], { grade: 'partial', at: '2026-10-06T11:00:00.000Z', source: 'trainer' });
  assert.deepEqual(trainer.recordTrainerGrade(dir, id, { now }), { recorded: false, reason: 'already-recorded' });
  assert.deepEqual(trainer.recordTrainerGrade(dir, 'tq_nope', { now }), { recorded: false, reason: 'not-a-workbook-question' });
});

test('the CLI prints one JSON line and fails cleanly', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [{ qid: 'intro-2', grade: 'missed', at: '2026-10-05T10:00:00.000Z', source: 'dashboard' }]);
  const ok = spawnSync(process.execPath, [CLI, 'pick', '--data-dir', dir, '--now', '2026-10-06T10:00:00.000Z'], { encoding: 'utf-8' });
  assert.equal(ok.status, 0);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.picked, true);
  assert.equal(out.record, undefined);
  assert.match(out.message, /workbook review/);
  const bad = spawnSync(process.execPath, [CLI, 'pick'], { encoding: 'utf-8' });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /--data-dir/);
});

test('history from any source stays queued after got, retires, and reopens after a miss', () => {
  const { dir, m } = rig();
  const qid = 'intro-2';
  const key = `${m.id}:${qid}`;
  for (const [grade, iso, source, stage, retired] of [
    ['missed', '2026-10-01T10:00:00Z', 'interview', 0, false],
    ['got', '2026-10-02T10:00:00Z', 'trainer', 1, false],
    ['got', '2026-10-05T10:00:00Z', 'dashboard', 2, false],
    ['got', '2026-10-12T10:00:00Z', 'trainer', 2, true],
    ['partial', '2026-10-13T10:00:00Z', 'dashboard', 0, false],
  ]) {
    store.writeGrades(dir, m.id, [{ qid, grade, at: iso, source }]);
    const state = trainer.buildReviewQueue(dir)[key];
    assert.deepEqual([state.stage, state.retired], [stage, retired]);
  }
  assert.equal(trainer.buildReviewQueue(dir)[key].dueAt, '2026-10-14T10:00:00.000Z');
});

test('an in-progress workbook item is not sent again and repeated pinned picks have unique ids', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [{ qid: 'intro-2', grade: 'missed', at: '2026-10-05T10:00:00.000Z' }]);
  const now = at('2026-10-06T10:00:00.000Z');
  const first = trainer.pickWorkbookQuestion(dir, { now });
  const qs = questions(dir);
  qs[0].status = 'in-progress';
  qs.push({ id: 'normal_1', status: 'answered' }, { id: 'normal_2', status: 'answered' });
  saveQuestions(dir, qs);
  assert.deepEqual(trainer.pickWorkbookQuestion(dir, { now }), { picked: false, reason: 'nothing-due' });
  qs[0].status = 'skipped';
  saveQuestions(dir, qs);
  const second = trainer.pickWorkbookQuestion(dir, { now });
  const next = questions(dir);
  next.at(-1).status = 'skipped';
  next.push({ id: 'normal_3', status: 'answered' }, { id: 'normal_4', status: 'answered' });
  saveQuestions(dir, next);
  const third = trainer.pickWorkbookQuestion(dir, { now });
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
});

test('a wrong MCQ answer resets the queue, and replaying a grade does not restamp history', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [
    { qid: 'intro-1', grade: 'missed', at: '2026-10-01T10:00:00Z' },
    { qid: 'intro-1', grade: 'got', at: '2026-10-02T10:00:00Z' },
  ]);
  const pick = trainer.pickWorkbookQuestion(dir, { now: at('2026-10-05T10:00:00Z') });
  const wrong = pick.record.choices.find((c) => !c.correct);
  const now = at('2026-10-05T11:00:00Z');
  const result = trainer.handleMcqReply(dir, wrong.text, { now });
  assert.equal(result.grade, 'missed');
  assert.match(result.text, /^🏁 Not quite/);
  assert.equal(trainer.buildReviewQueue(dir)[`${m.id}:intro-1`].stage, 0);
  const before = store.readProgress(dir, m.id);
  assert.deepEqual(trainer.recordTrainerGrade(dir, pick.id, { now: at('2026-10-06T11:00:00Z') }), { recorded: false, reason: 'already-recorded' });
  store.writeGrades(dir, m.id, [{ qid: 'intro-1', ...before.grades['intro-1'], source: 'dashboard' }]);
  assert.deepEqual(store.readProgress(dir, m.id), before);
});

test('recordTrainerGrade ignores final evaluation, invalid grades, and missing workbooks', () => {
  const { dir, m } = rig();
  saveQuestions(dir, [{ id: 'tq_eval', source: 'workbook', workbookId: m.id, qid: 'intro-2',
    initialEvaluation: { grade: 'partial' }, finalEvaluation: { grade: 'got' } }]);
  assert.deepEqual(trainer.recordTrainerGrade(dir, 'tq_eval', { now: at('2026-10-06T10:00:00Z') }), { recorded: true, grade: 'partial' });
  const qs = questions(dir);
  qs.push({ id: 'tq_invalid', source: 'workbook', workbookId: m.id, initialEvaluation: { grade: 'invalid' } });
  qs.push({ id: 'tq_deleted', source: 'workbook', workbookId: 'deleted', initialEvaluation: { grade: 'got' } });
  saveQuestions(dir, qs);
  assert.deepEqual(trainer.recordTrainerGrade(dir, 'tq_invalid'), { recorded: false, reason: 'no-grade' });
  assert.deepEqual(trainer.recordTrainerGrade(dir, 'tq_deleted'), { recorded: false, reason: 'workbook-missing' });
});

test('CLI mcq and record use the pinned clock and return one JSON line', () => {
  const { dir, m } = rig();
  store.writeGrades(dir, m.id, [{ qid: 'intro-1', grade: 'missed', at: '2026-10-05T10:00:00Z' }]);
  const picked = trainer.pickWorkbookQuestion(dir, { now: at('2026-10-06T10:00:00Z') });
  const file = path.join(dir, 'reply.txt');
  fs.writeFileSync(file, picked.record.choices.find((c) => c.correct).text);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--data-dir', dir, '--now', '2026-10-06T11:00:00Z'], { encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('mcq', '--answer-file', file).grade, 'got');
  saveQuestions(dir, [...questions(dir), { id: 'tq_open', source: 'workbook', workbookId: m.id,
    qid: 'intro-2', initialEvaluation: { grade: 'partial' } }]);
  assert.deepEqual(run('record', '--id', 'tq_open'), { recorded: true, grade: 'partial' });
  assert.equal(store.readProgress(dir, m.id).grades['intro-2'].at, '2026-10-06T11:00:00.000Z');
});

test('CLI rejects invalid dates and missing flag values before writing data', () => {
  const dir = tmp();
  for (const args of [
    ['pick', '--data-dir', dir, '--now', 'invalid'],
    ['pick', '--data-dir', dir, '--now'],
    ['pick', '--data-dir', '--now', '2026-10-06T10:00:00Z'],
    ['record', '--data-dir', dir, '--id', '--now', '2026-10-06T10:00:00Z'],
    ['mcq', '--data-dir', dir],
    ['unknown', '--data-dir', dir],
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(typeof JSON.parse(result.stdout).error, 'string');
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});
