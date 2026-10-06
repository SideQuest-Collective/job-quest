// app/tests/workbook-parse.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAttrs, parseFile, parseContentDir, parseChoices, parseTests, referenceSolution } = require('../lib/workbook/parse');
const { writeKit, CH1 } = require('./helpers/workbook-fixture');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-parse-')); }

test('parseAttrs handles bare and quoted values', () => {
  assert.deepEqual(parseAttrs('id=a company=both topic="Coding rounds" diff=2'), { id: 'a', company: 'both', topic: 'Coding rounds', diff: '2' });
});

test('parseFile splits chapters and questions with sections and line numbers', () => {
  const r = parseFile(CH1, '10-intro.md');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.questions.length, 2);
  const [c] = r.chapters;
  assert.equal(c.id, 'intro');
  assert.equal(c.title, 'Acme basics');
  assert.equal(c.mins, '4');
  assert.equal(c.line, 1);
  assert.match(c.body, /^## In plain English/);
  const [q1, q2] = r.questions;
  assert.equal(q1.type, 'mcq');
  assert.equal(q1.diff, 1);
  assert.equal(q1.body, 'What does Acme sell?');
  assert.equal(q1.sections.choices, 12);
  assert.equal(q2.hint, 'Think about fan-out.');
  assert.equal(q2.rubric, '- Mentions fan-out on write.');
  assert.equal(q2.file, '10-intro.md');
  assert.deepEqual(r.items.map((x) => x.id), ['intro', 'intro-1', 'intro-2']);
});

test('defaults: missing type is open, bad diff is 2', () => {
  const r = parseFile('@@chapter id=c\nx\n@@q id=q1 diff=9 chapter=c\nprompt\n@@answer\nyes\n', 'a.md');
  assert.equal(r.questions[0].type, 'open');
  assert.equal(r.questions[0].diff, 2);
});

test('parseContentDir reads .md files and glossary files in name order', () => {
  const dir = tmp();
  writeKit(dir, { 'notes.txt': 'ignored' });
  const r = parseContentDir(path.join(dir, 'content'));
  assert.deepEqual(r.files.map((f) => f.name), ['10-intro.md', '20-algo.md']);
  assert.deepEqual(r.glossaryFiles.map((f) => f.name), ['glossary-10-intro.txt', 'glossary-20-algo.txt']);
  assert.equal(r.chapters.length, 2);
  assert.equal(r.questions.length, 3);
});

test('parseContentDir on a missing directory is empty', () => {
  const r = parseContentDir(path.join(tmp(), 'nope'));
  assert.deepEqual([r.chapters.length, r.questions.length, r.files.length], [0, 0, 0]);
});

test('parseChoices joins continuation lines and marks the correct one', () => {
  assert.deepEqual(parseChoices('- [ ] one\n  more\n- [X] two\n- [ ] three'), [
    { text: 'one more', correct: false }, { text: 'two', correct: true }, { text: 'three', correct: false },
  ]);
});

test('parseTests accepts fenced JSON with cases or calls and rejects bad shapes', () => {
  assert.equal(parseTests('```json\n{"entry":"f","cases":[{"args":[1],"expect":2}]}\n```').ok, true);
  assert.equal(parseTests('{"entry":"C","calls":[["__init__",[2],null],["get",[1],-1]]}').ok, true);
  assert.match(parseTests(null).error, /missing/);
  assert.match(parseTests('```json\n{nope\n```').error, /not valid JSON/);
  assert.match(parseTests('{"cases":[]}').error, /entry/);
  assert.match(parseTests('{"entry":"f"}').error, /exactly one/);
  assert.match(parseTests('{"entry":"f","cases":[{"args":1,"expect":2}]}').error, /args/);
  assert.match(parseTests('{"entry":"C","calls":[["get",1]]}').error, /method/);
});

test('referenceSolution picks the longest python block that defines entry', () => {
  const answer = 'Idea.\n\n```python\ndef f(x): ...\n```\n\nFull:\n\n```python\ndef f(x):\n    return x * 2\n```\n\n```python\ndef g(): pass\n```';
  assert.equal(referenceSolution(answer, 'f'), 'def f(x):\n    return x * 2\n');
  assert.equal(referenceSolution(answer, 'h'), null);
  assert.match(referenceSolution('```python\nclass LRU:\n    pass\n```', 'LRU'), /class LRU/);
});
