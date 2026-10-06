// app/tests/workbook-codelab.test.js
// Verified workbook code questions appear in Code Lab and the viewer links to them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/workbook/store');
const { getWorkbookCodeProblems } = require('../lib/workbook/codelab');
const { runPythonTests, lintProblems } = require('../lib/codelab/runner');
const { createProblemStore } = require('../lib/codelab/store');
const { writeKit } = require('./helpers/workbook-fixture');

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-codelab-'));
  const meta = store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'], status: 'ready' });
  writeKit(store.wbDir(dir, meta.id));
  const extra = [
    '@@q id=algo-2 company=both topic="Algorithms" type=code diff=3 chapter=algo',
    '## Build a counter',
    'Implement `Counter` with `add(k)` and `get(k)`.',
    '@@tests',
    '```json',
    '{"entry": "Counter", "calls": [["__init__", [10], null], ["add", ["a"], 11], ["get", ["a"], 11], ["get", ["b"], 10]]}',
    '```',
    '@@answer',
    '```python',
    'from collections import defaultdict',
    '',
    'class Counter:',
    '    def __init__(self, start):',
    '        self.c = defaultdict(lambda: start)',
    '    def add(self, k):',
    '        self.c[k] += 1',
    '        return self.c[k]',
    '    def get(self, k):',
    '        return self.c[k]',
    '```',
    '',
  ].join('\n');
  const content = path.join(store.wbDir(dir, meta.id), 'content');
  const file = fs.readdirSync(content).find((f) => f.endsWith('.md') && fs.readFileSync(path.join(content, f), 'utf-8').includes('id=algo-1'));
  fs.appendFileSync(path.join(content, file), `\n${extra}`);
  store.writeJsonAtomic(path.join(store.wbDir(dir, meta.id), 'verify.json'), { checkedAt: 'x', chapters: { algo: [{ qid: 'algo-1', pass: true }, { qid: 'algo-2', pass: true }] } });
  return { dir, meta };
}

test('verified code questions become runnable Code Lab problems with generated starters', (t) => {
  const { dir, meta } = seed();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const problems = getWorkbookCodeProblems(dir);
  assert.deepEqual(problems.map((p) => [p.functionName, p.difficulty, p.category]), [['add_one', 'medium', 'workbook'], ['Counter', 'hard', 'workbook']]);
  const [fn, cls] = problems;
  assert.equal(fn.id, store.codeProblemId(meta.id, 'algo-1'));
  assert.equal(fn.starterCode, 'def add_one(x):\n    pass\n');
  assert.equal(cls.title, 'Build a counter');
  assert.match(cls.starterCode, /^from collections import defaultdict\n\nclass Counter:\n\n    def __init__\(self, start\):\n        pass/);
  assert.doesNotMatch(cls.starterCode, /self\.c\[k\] \+= 1/);
  assert.deepEqual(cls.testCases, [{ input: { init: [10], operations: [['add', 'a'], ['get', 'a'], ['get', 'b']] }, expected: [11, 11, 10] }]);
  assert.deepEqual(Object.values(lintProblems(problems)), [[], []]);
  // The starter loads, fails honestly, and a real solution passes in Code Lab's runner.
  assert.ok(runPythonTests(fn.starterCode, fn.functionName, fn.testCases).results.every((r) => !r.passed));
  assert.ok(runPythonTests('def add_one(x):\n    return x + 1\n', fn.functionName, fn.testCases).results.every((r) => r.passed));
  const solution = 'class Counter:\n    def __init__(self, start):\n        self.s, self.c = start, {}\n    def add(self, k):\n        self.c[k] = self.c.get(k, self.s) + 1\n        return self.c[k]\n    def get(self, k):\n        return self.c.get(k, self.s)\n';
  assert.ok(runPythonTests(solution, 'Counter', cls.testCases).results.every((r) => r.passed));
});

test('unverified or failing questions are not offered; the viewer marks verified ones; Code Lab lists them', (t) => {
  const { dir, meta } = seed();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.writeJsonAtomic(path.join(store.wbDir(dir, meta.id), 'verify.json'), { chapters: { algo: [{ qid: 'algo-1', pass: true }, { qid: 'algo-2', pass: false }] } });
  assert.deepEqual(getWorkbookCodeProblems(dir).map((p) => p.qid), ['algo-1']);
  const qs = store.viewerContent(dir, meta.id).questions;
  assert.equal(qs.find((q) => q.id === 'algo-1').codeProblemId, store.codeProblemId(meta.id, 'algo-1'));
  assert.equal(qs.find((q) => q.id === 'algo-2').codeProblemId, undefined);
  const listed = createProblemStore(dir, { log: () => {} }).read();
  assert.ok(listed.categories.some((c) => c.id === 'workbook'));
  assert.deepEqual(listed.problems.map((p) => p.qid), ['algo-1']);
});

test('the viewer shows Open in Code Lab and the dashboard honours ?problem=', () => {
  const viewer = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbook.html'), 'utf-8');
  assert.match(viewer, /if\(q\.codeProblemId&&!OFFLINE\)h\+='<div class="row" style="margin:6px 0 4px"><a class="btn" href="\/\?problem='\+encodeURIComponent\(q\.codeProblemId\)\+'" target="_blank" rel="noopener">Open in Code Lab<\/a><\/div>';/);
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  assert.match(index, /get\('problem'\);\s*if \(problem\) \{\s*codeLabInitialProblemRef\.current = problem;\s*setPage\('codelab'\);/);
  assert.match(index, /adapters: problem\.adapters \|\| null/);
});
