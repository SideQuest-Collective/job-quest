// app/tests/workbook-glossary.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseGlossaryText, mergeGlossaries, loadNolink } = require('../lib/workbook/glossary');
const { GLOSS1, GLOSS2 } = require('./helpers/workbook-fixture');

const NOLINK_FILE = path.resolve(__dirname, '..', '..', 'skill', 'references', 'workbook', 'nolink.txt');

test('parseGlossaryText skips comments and blanks, strips backticks and stars, reports bad lines', () => {
  const r = parseGlossaryText('# c\n\n`Big-O` :: growth\n**heap** :: tree\nno separator here\nX :: too short\nempty ::   \n', 'g.txt');
  assert.deepEqual(r.entries.map((e) => [e.term, e.def, e.line]), [['Big-O', 'growth', 3], ['heap', 'tree', 4]]);
  assert.deepEqual(r.errors.map((e) => [e.line, e.rule]), [[5, 'glossary-line'], [6, 'glossary-line'], [7, 'glossary-line']]);
});

test('merge keeps the longest definition, marks nolink words, sorts by key', () => {
  const merged = mergeGlossaries([{ name: 'glossary-10-intro.txt', text: GLOSS1 }, { name: 'glossary-20-algo.txt', text: GLOSS2 }], new Set(['heap']));
  assert.deepEqual(merged, [
    { t: 'Fan-out', d: 'Copying one write to many readers.' },
    { t: 'heap', d: 'A tree kept in priority order.', nl: 1 },
    { t: 'two pointers', d: 'Two indexes moving through one list.' },
    { t: 'widget', d: 'A small manufactured thing that does one job.' },
  ]);
});

test('ties keep the first definition seen (build.py uses a strict >)', () => {
  const merged = mergeGlossaries([{ name: 'a', text: 'Key :: abc\n' }, { name: 'b', text: 'key :: xyz\n' }], new Set());
  assert.deepEqual(merged, [{ t: 'Key', d: 'abc' }]);
});

test('merge output is byte-identical across runs', () => {
  const files = [{ name: 'a', text: GLOSS2 }, { name: 'b', text: GLOSS1 }];
  const a = JSON.stringify(mergeGlossaries(files, new Set(['widget'])));
  const b = JSON.stringify(mergeGlossaries(files, new Set(['widget'])));
  assert.equal(a, b);
});

test('the shipped nolink list has the generic everyday words and no company names', () => {
  const set = loadNolink(NOLINK_FILE);
  assert.equal(set.size, 73);
  for (const w of ['heap', 'queue', 'state', 'promise', 'yield']) assert.ok(set.has(w), w);
  assert.equal(set.has('acme'), false);
  assert.equal(loadNolink('/nonexistent/nolink.txt').size, 0);
});
