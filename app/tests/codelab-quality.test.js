// app/tests/codelab-quality.test.js
// Long-term guards for Code Lab problems: one checked way in (add-problems), migration of old
// converter-wrapping starters, and a lint that flags any problem whose starter doesn't match its tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { migrateProblem, migrateProblemsFile } = require('../lib/codelab/migrate');
const { runPythonTests, lintProblems } = require('../lib/codelab/runner');
const { createProblemStore } = require('../lib/codelab/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codelab-q-'));
const CLI = path.resolve(__dirname, '..', '..', 'skill', 'bin', 'add-problems.js');
const SEED = path.resolve(__dirname, '..', '..', 'skill', 'seed', 'problems.json');

const TREE = `class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def _build_tree(arr):
    if not arr or arr[0] is None:
        return None
    root = TreeNode(arr[0]); queue, i = [root], 1
    while queue and i < len(arr):
        node = queue.pop(0)
        if i < len(arr) and arr[i] is not None:
            node.left = TreeNode(arr[i]); queue.append(node.left)
        i += 1
        if i < len(arr) and arr[i] is not None:
            node.right = TreeNode(arr[i]); queue.append(node.right)
        i += 1
    return root

def _serialize_tree(root):
    out, queue = [], [root] if root else []
    while queue:
        n = queue.pop(0)
        out.append(n.val if n else None)
        if n: queue += [n.left, n.right]
    while out and out[-1] is None: out.pop()
    return out
`;
const wrapped = () => ({
  id: 'invert-binary-tree', title: 'Invert', category: 'trees', difficulty: 'easy', order: 3, functionName: 'invert_tree',
  description: 'Invert the tree.\n\n**Starter note:** the runner will serialize it back to an array.',
  starterCode: `${TREE}\n\ndef invert_tree(root):\n    tree = _build_tree(root)\n    # Your code\n\n    return _serialize_tree(tree)\n`,
  testCases: [{ input: { root: [4, 2, 7] }, expected: [4, 7, 2] }, { input: { root: [] }, expected: [] }],
  examples: [], constraints: [], hints: [], tags: [],
});
const RECURSIVE = 'def invert_tree(root):\n    if root is None:\n        return None\n    root.left, root.right = invert_tree(root.right), invert_tree(root.left)\n    return root\n';

test('lint flags a starter that converts test data inside the user function; migration fixes it and recursion works', () => {
  const old = wrapped();
  assert.match(lintProblems([old])[old.id][0], /calls _build_tree\(\) itself; declare adapters/);
  // The recursive solution fails against the old wrapped starter, which is the bug users hit.
  const before = runPythonTests(old.starterCode.replace(/def invert_tree[\s\S]*/, RECURSIVE), 'invert_tree', old.testCases);
  assert.ok(before.results.some((r) => !r.passed));
  const p = migrateProblem(old);
  assert.deepEqual(p.adapters, { args: { root: 'tree' }, returns: 'tree' });
  assert.doesNotMatch(p.starterCode, /_build_tree|_serialize_tree/);
  assert.match(p.starterCode, /^class TreeNode:/);
  assert.match(p.starterCode, /def invert_tree\(root\):\n {4}"""root: a TreeNode or None/);
  assert.doesNotMatch(p.description, /Starter note/);
  assert.deepEqual(lintProblems([p])[p.id], []);
  const code = p.starterCode.slice(0, p.starterCode.indexOf('def invert_tree')) + RECURSIVE;
  assert.deepEqual(runPythonTests(code, 'invert_tree', p.testCases, { adapters: p.adapters }).results.map((r) => r.passed), [true, true]);
  assert.equal(migrateProblem(p), null, 'idempotent');
});

test('lint catches signature, operation and expected-shape mismatches', () => {
  const fn = { id: 'f', functionName: 'f', starterCode: 'def f(a, b):\n    pass\n', testCases: [{ input: { a: 1 }, expected: 1 }, { input: { a: 1, b: 2 }, expected: 3 }] };
  const cls = { id: 'c', functionName: 'C', starterCode: 'class C:\n    def __init__(self, n):\n        pass\n    def get(self, k):\n        pass\n',
    testCases: [{ input: { n: 1, operations: [['get', 1], ['put', 1, 2]] }, expected: [null, null] }, { input: { n: 1, operations: [['get', 1]] }, expected: [null] }] };
  const shape = { ...cls, id: 's', testCases: [{ input: { n: 1, operations: [['get', 1]] }, expected: null }, { input: { n: 1, operations: [] }, expected: [] }] };
  const missing = { id: 'm', functionName: 'g', starterCode: 'def f():\n    pass\n', testCases: [] };
  const found = lintProblems([fn, cls, shape, missing]);
  assert.match(found.f[0], /test 0 input keys \['a'\] do not match f\(a, b\)/);
  assert.match(found.c[0], /calls put\(\), which the starter class does not define/);
  assert.match(found.s[0], /expected must be a list with one entry per operation/);
  assert.match(found.m[0], /does not define g/);
});

test('every seed problem passes lint, and the seeded tree/list/graph problems use adapters', () => {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf-8')).problems;
  const found = lintProblems(seed);
  assert.deepEqual(Object.entries(found).filter(([, v]) => v.length), []);
  for (const id of ['reverse-linked-list', 'binary-tree-level-order', 'clone-graph', 'invert-binary-tree']) {
    assert.ok(seed.find((p) => p.id === id).adapters, id);
  }
  const inv = seed.find((p) => p.id === 'invert-binary-tree');
  const code = inv.starterCode.slice(0, inv.starterCode.indexOf('def invert_tree')) + RECURSIVE;
  assert.ok(runPythonTests(code, 'invert_tree', inv.testCases, { adapters: inv.adapters }).results.every((r) => r.passed));
});

test('the dashboard store migrates on change, keeps one backup, and flags problems that still do not match', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'problems', 'problems.json');
  fs.mkdirSync(path.dirname(file));
  const broken = { id: 'broken', title: 'B', functionName: 'f', starterCode: 'def f(a):\n    pass\n', testCases: [{ input: { b: 1 }, expected: 1 }, { input: { b: 2 }, expected: 2 }] };
  fs.writeFileSync(file, JSON.stringify({ categories: [], problems: [wrapped(), broken] }));
  const logs = [];
  const store = createProblemStore(dir, { log: (m) => logs.push(m) });
  const data = store.read();
  assert.ok(data.problems[0].adapters);
  assert.equal(data.problems[0].issues, undefined);
  assert.match(data.problems[1].issues[0], /do not match f\(a\)/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).problems[1].issues, undefined, 'issues are never written to disk');
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('before-adapters')).length, 1);
  assert.ok(logs.some((m) => /moved 1 problem/.test(m)) && logs.some((m) => /do not match their tests: broken/.test(m)));
  assert.equal(store.read(), data, 'cached until the file changes');
  assert.deepEqual(migrateProblemsFile(dir).migrated, []);
});

test('add-problems CLI rejects a mismatched or unverifiable problem and writes nothing; a good one is added', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'in.json');
  const good = { id: 'acme-sum', title: 'Sum', category: 'acme', difficulty: 'easy', description: 'Add.', starterCode: 'def add(a, b):\n    pass\n',
    functionName: 'add', referenceSolution: 'def add(a, b):\n    return a + b\n', testCases: [{ input: { a: 1, b: 2 }, expected: 3 }, { input: { a: 0, b: 0 }, expected: 0 }] };
  const run = (problems) => {
    fs.writeFileSync(file, JSON.stringify({ problems }));
    const r = spawnSync(process.execPath, [CLI, file, '--data-dir', path.join(dir, 'data')], { encoding: 'utf-8' });
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
  const mismatch = run([{ ...good, testCases: [{ input: { x: 1 }, expected: 1 }, { input: { x: 2 }, expected: 2 }] }]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.out.error, /do not match add\(a, b\)/);
  const wrong = run([{ ...good, referenceSolution: 'def add(a, b):\n    return a - b\n' }]);
  assert.match(wrong.out.error, /reference solution fails test 0/);
  const wrap = run([{ ...wrapped(), id: 'acme-invert', category: 'acme', referenceSolution: RECURSIVE }]);
  assert.match(wrap.out.error, /declare adapters/);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'problems', 'problems.json')), false);
  const ok = run([good]);
  assert.deepEqual([ok.status, ok.out], [0, { added: ['acme-sum'], tests: 2 }]);
});
