// app/tests/interview-practice.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPracticeSet, roundFilter } = require('../lib/interview/practice');
const { normalizeProgress, mergeProgress } = require('../lib/workbook/progress');

const Q = (id, type, topic, diff, extra = {}) => ({ id, chapter: 'ch', type, topic, diff, prompt: `P ${id}`, choices: [], rubric: `R ${id}`, answer: `A ${id}`, ...extra });
const QUESTIONS = [
  Q('code-easy', 'code', 'Coding', 1),
  Q('code-hard', 'code', 'Coding', 3),
  Q('algo-open', 'open', 'Algorithms and data structures', 2),
  Q('sd1', 'open', 'System design', 3),
  Q('sd2', 'mcq', 'System Design', 1, { choices: ['Token bucket', 'Fixed window', 'Leaky bucket'] }),
  Q('beh', 'open', 'Behavioral', 1),
  Q('co', 'open', 'Company context', 1),
];
const ids = (set) => set.questions.map((q) => q.qid);
const build = (round, progress = {}, limit) => buildPracticeSet({ roleKey: 'Acme|SWE', workbookId: 'acme-swe', round, questions: QUESTIONS, progress, limit });

test('coding picks code questions or coding topics', () => {
  assert.deepEqual(ids(build('coding')), ['code-easy', 'algo-open', 'code-hard']);
});

test('system picks topic "System design" case-insensitively', () => {
  assert.deepEqual(ids(build('system')), ['sd2', 'sd1']);
});

test('behavioral picks topic "Behavioral"; screen picks everything else', () => {
  assert.deepEqual(ids(build('behavioral')), ['beh']);
  assert.deepEqual(ids(build('screen')), ['co', 'code-easy', 'sd2', 'algo-open', 'code-hard', 'sd1']);
});

test('recruiter has no practice rule', () => {
  assert.equal(roundFilter('recruiter'), null);
  assert.equal(build('recruiter'), null);
});

test('misses first, then partial, then ungraded, then got; difficulty breaks ties', () => {
  const progress = { grades: {
    'code-hard': { grade: 'missed', at: '2026-09-01T00:00:00Z', source: 'dashboard' },
    'algo-open': { grade: 'partial', at: '2026-09-02T00:00:00Z', source: 'trainer' },
    'code-easy': { grade: 'got', at: '2026-09-03T00:00:00Z', source: 'dashboard' },
  } };
  assert.deepEqual(ids(build('coding', progress)), ['code-hard', 'algo-open', 'code-easy']);
});

test('set carries the contract header and question fields; limit caps the list', () => {
  const set = build('system', {}, 1);
  assert.deepEqual(Object.keys(set), ['_generatedBy', 'contract', 'roleKey', 'workbookId', 'round', 'questions']);
  assert.equal(set._generatedBy, 'job-quest');
  assert.equal(set.contract, 'jq-interview/1');
  assert.equal(set.roleKey, 'Acme|SWE');
  assert.equal(set.workbookId, 'acme-swe');
  assert.equal(set.round, 'system');
  assert.deepEqual(set.questions, [{ qid: 'sd2', prompt: 'P sd2', type: 'mcq', rubric: 'R sd2', answer: 'A sd2', choices: ['Token bucket', 'Fixed window', 'Leaky bucket'] }]);
});

test('real P1 progress uses the latest grade, including out-of-order and equal-time writes', () => {
  let progress = normalizeProgress({});
  progress = mergeProgress(progress, { grades: {
    'code-hard': { grade: 'got', at: '2026-09-01T00:00:00Z', source: 'dashboard' },
    'algo-open': { grade: 'partial', at: '2026-09-02T00:00:00Z', source: 'trainer' },
    sd1: { grade: 'got', at: '2026-09-02T00:00:00Z', source: 'dashboard' },
  } });
  progress = mergeProgress(progress, { grades: {
    'code-hard': { grade: 'missed', at: '2026-09-03T00:00:00Z', source: 'interview-practice' },
  } });
  for (const at of ['2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z']) {
    progress = mergeProgress(progress, { grades: {
      'code-hard': { grade: 'got', at, source: 'dashboard' },
    } });
  }
  progress = normalizeProgress(progress);
  assert.deepEqual(progress.grades['code-hard'], {
    grade: 'missed', at: '2026-09-03T00:00:00.000Z', source: 'interview-practice',
  });
  assert.deepEqual(ids(build('screen', progress)), ['code-hard', 'algo-open', 'co', 'code-easy', 'sd2', 'sd1']);
});

test('default limit is 20 and difficulty then qid break ties within a grade', () => {
  const questions = Array.from({ length: 25 }, (_, i) => Q(`q${String(i).padStart(2, '0')}`, 'code', 'Coding', i % 3 + 1)).reverse();
  const set = buildPracticeSet({ roleKey: 'Acme|SWE', workbookId: 'acme-swe', round: 'coding', questions });
  assert.deepEqual(ids(set), [
    'q00', 'q03', 'q06', 'q09', 'q12', 'q15', 'q18', 'q21', 'q24',
    'q01', 'q04', 'q07', 'q10', 'q13', 'q16', 'q19', 'q22',
    'q02', 'q05', 'q08',
  ]);
  assert.deepEqual(build('coding', {}, 0), build('coding'));
});

for (const limit of [-1, null, undefined, 0, NaN, 1.5, '2', Infinity]) {
  test(`practice limit ${String(limit)} (${typeof limit}) uses the default of 20`, () => {
    const questions = Array.from({ length: 25 }, (_, i) => Q(`q${String(i).padStart(2, '0')}`, 'code', 'Coding', 2));
    const input = { roleKey: 'Acme|SWE', workbookId: 'acme-swe', round: 'coding', questions };
    const expected = buildPracticeSet(input);
    assert.equal(expected.questions.length, 20);
    assert.deepEqual(buildPracticeSet({ ...input, limit }), expected);
  });
}

test('building is repeatable, preserves inputs, and copies choices', () => {
  const questions = QUESTIONS.map((q) => Object.freeze({ ...q, choices: Object.freeze(q.choices.slice()) }));
  Object.freeze(questions);
  const progress = Object.freeze({ grades: Object.freeze({ sd1: Object.freeze({
    grade: 'missed', at: '2026-09-01T00:00:00Z', source: 'dashboard',
  }) }) });
  const input = { roleKey: 'Acme|SWE', workbookId: 'acme-swe', round: 'system', questions, progress };
  const before = JSON.stringify(input);
  const set = buildPracticeSet(input);
  assert.deepEqual(set, buildPracticeSet(input));
  set.questions.find((q) => q.qid === 'sd2').choices.push('Changed');
  assert.equal(JSON.stringify(input), before);
});

test('unsupported rounds return null and supported rounds with no matches return an empty set', () => {
  assert.equal(roundFilter('unknown'), null);
  assert.equal(build('unknown'), null);
  const set = buildPracticeSet({ roleKey: 'Acme|SWE', workbookId: 'acme-swe', round: 'coding', questions: [] });
  assert.deepEqual(set.questions, []);
});

test('blank prompts and missing ids are excluded before ranking and limiting', () => {
  const invalid = [
    Q('empty', 'code', 'Coding', 1, { prompt: '' }),
    Q('whitespace', 'code', 'Coding', 1, { prompt: '   ' }),
    Q(undefined, 'code', 'Coding', 1),
    Q('', 'code', 'Coding', 1),
  ];
  const progress = { grades: { 'code-hard': { grade: 'missed' } } };
  const input = { roleKey: 'Acme|SWE', workbookId: 'acme-swe', round: 'coding', progress, limit: 3 };
  const set = buildPracticeSet({ ...input, questions: [...invalid, ...QUESTIONS] });
  assert.deepEqual(set, build('coding', progress, 3));
  assert.deepEqual(ids(set), ['code-hard', 'code-easy', 'algo-open']);
  assert.deepEqual(
    buildPracticeSet({ ...input, questions: invalid }),
    buildPracticeSet({ ...input, questions: [] }),
  );
});

test('qid ties use code-unit order for mixed case and accented ids', () => {
  const questions = ['é', 'a', 'Z', 'ä', 'A'].map((id) => Q(id, 'code', 'Coding', 2));
  const set = buildPracticeSet({ roleKey: 'Acme|SWE', workbookId: 'acme-swe', round: 'coding', questions });
  assert.deepEqual(ids(set), ['A', 'Z', 'a', 'ä', 'é']);
});
