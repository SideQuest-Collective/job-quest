// app/tests/workbook-outline.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOutline, assignIds, headerLines, extractJsonObject } = require('../lib/workbook/outline');
const { screenOutline, onsiteOutline } = require('./helpers/workbook-outlines');

const clone = (v) => JSON.parse(JSON.stringify(v));

test('the fixture outlines are valid for their tiers', () => {
  assert.deepEqual(validateOutline(screenOutline(), { tier: 'screen' }), []);
  assert.deepEqual(validateOutline(onsiteOutline(), { tier: 'onsite', existingIds: screenOutline().chapters.map((c) => c.id) }), []);
});

test('screen budget: chapter count, question count, required kinds, type mix', () => {
  const few = clone(screenOutline());
  few.chapters = few.chapters.slice(0, 4);
  const e = validateOutline(few, { tier: 'screen' });
  assert.ok(e.some((x) => /expected 5-7 chapters, got 4/.test(x)));
  assert.ok(e.some((x) => /expected 25-35 questions in total, got 20/.test(x)));
  const noBehavioral = clone(screenOutline());
  noBehavioral.chapters[3].kind = 'concepts';
  noBehavioral.chapters[3].topic = 'People';
  assert.ok(validateOutline(noBehavioral, { tier: 'screen' }).some((x) => /kind "behavioral"/.test(x)));
  const allMcq = clone(screenOutline());
  for (const c of allMcq.chapters) for (const qq of c.questions) qq.type = 'mcq';
  const mix = validateOutline(allMcq, { tier: 'screen' });
  assert.ok(mix.some((x) => /at least 5 open questions/.test(x)));
  assert.ok(mix.some((x) => /at least 5 code questions/.test(x)));
});

test('the 20% share uses integer math (35 questions needs 7, not 8)', () => {
  const o = clone(screenOutline());
  o.chapters.push({ id: 'extra', title: 'Extra', topic: 'Extra', company: 'both', kind: 'concepts', summary: 's',
    questions: [{ type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }, { type: 'mcq', diff: 1, focus: 'f' }] });
  o.chapters[0].questions[1].type = 'mcq';
  // open is now exactly 7 of 35; floating-point 0.2 * 35 would demand 8
  assert.deepEqual(validateOutline(o, { tier: 'screen' }), []);
});

test('field rules: ids, fixed topics, quotes, company slug, questions', () => {
  const o = clone(screenOutline());
  o.chapters[1].id = 'Arrays!';
  o.chapters[2].topic = 'Systems';
  o.chapters[4].title = 'Say "cache"';
  o.chapters[0].company = 'Acme Inc';
  o.chapters[1].questions[0] = { type: 'essay', diff: 4, focus: '' };
  const e = validateOutline(o, { tier: 'screen' });
  for (const re of [/chapters\[1\]\.id/, /topic must be "System design"/, /double quotes/, /company slug/, /type must be mcq/, /diff must be 1, 2, or 3/, /focus/]) {
    assert.ok(e.some((x) => re.test(x)), String(re));
  }
});

test('onsite: existing ids are rejected and repeats are rejected', () => {
  const o = onsiteOutline();
  o.chapters[1].id = 'arrays';
  o.chapters[2].id = 'onsite-loop';
  const e = validateOutline(o, { tier: 'onsite', existingIds: ['arrays'] });
  assert.ok(e.some((x) => /"arrays" already exists/.test(x)));
  assert.ok(e.some((x) => /"onsite-loop" is repeated/.test(x)));
  assert.deepEqual(validateOutline({ nope: 1 }, { tier: 'screen' }), ['"chapters" must be an array']);
});

test('assignIds numbers files and questions from startIndex', () => {
  const a = assignIds(screenOutline(), { runId: 'r1' });
  assert.deepEqual(a.chapters.map((c) => [c.nn, c.file, c.glossaryFile]), [
    ['01', '01-acme-context.md', 'glossary-01.txt'], ['02', '02-arrays.md', 'glossary-02.txt'], ['03', '03-feed-design.md', 'glossary-03.txt'],
    ['04', '04-stories.md', 'glossary-04.txt'], ['05', '05-caching.md', 'glossary-05.txt'],
  ]);
  assert.deepEqual(a.chapters[1].questions.map((x) => x.id), ['arrays-q1', 'arrays-q2', 'arrays-q3', 'arrays-q4', 'arrays-q5']);
  assert.equal(a.chapters[0].addedBy, 'r1');
  assert.equal(assignIds(onsiteOutline(), { startIndex: 5 }).chapters[0].file, '06-onsite-loop.md');
});

test('headerLines are exact directive lines', () => {
  const [c] = assignIds(screenOutline()).chapters;
  assert.deepEqual(headerLines(c).slice(0, 2), [
    '@@chapter id=acme-context company=acme topic="Company" title="Acme and the role"',
    '@@q id=acme-context-q1 company=acme topic="Company" type=mcq diff=1 chapter=acme-context',
  ]);
  assert.equal(headerLines(c).length, 6);
});

test('extractJsonObject finds the object in plain, fenced, or chatty replies', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJsonObject('Sure! {"a":"has } brace","b":{"c":3}} done'), { a: 'has } brace', b: { c: 3 } });
  assert.equal(extractJsonObject('[1,2]'), null);
  assert.equal(extractJsonObject('no json here'), null);
});

test('extractJsonObject rejects arrays containing objects in plain or fenced replies', () => {
  assert.equal(extractJsonObject('[{"a":1}]'), null);
  assert.equal(extractJsonObject('Here:\n```json\n[{"a":2}]\n```'), null);
});
