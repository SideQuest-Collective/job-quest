// app/tests/codelab-runner.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPythonTests, adaptersError } = require('../lib/codelab/runner');

const passed = (r) => (r.results || []).map((x) => x.passed);

test('tree adapter lets a recursive solution receive and return TreeNodes', () => {
  const code = `
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def invert_tree(root):
    if root is None:
        return None
    root.left, root.right = invert_tree(root.right), invert_tree(root.left)
    return root
`;
  const tests = [{ input: { root: [4, 2, 7, 1, 3, 6, 9] }, expected: [4, 7, 2, 9, 6, 3, 1] }, { input: { root: [] }, expected: [] }];
  const r = runPythonTests(code, 'invert_tree', tests, { adapters: { args: { root: 'tree' }, returns: 'tree' } });
  assert.deepEqual(passed(r), [true, true], JSON.stringify(r));
});

test('list and graph adapters, and an int result from a tree argument', () => {
  const rev = 'def reverse_list(head):\n    prev = None\n    while head:\n        head.next, prev, head = prev, head, head.next\n    return prev\n';
  assert.deepEqual(passed(runPythonTests(rev, 'reverse_list', [{ input: { head: [1, 2, 3] }, expected: [3, 2, 1] }, { input: { head: [] }, expected: [] }],
    { adapters: { args: { head: 'list' }, returns: 'list' } })), [true, true]);
  const clone = `
def clone_graph(adj_list):
    node = adj_list
    if node is None:
        return None
    copies = {}
    def walk(n):
        if n in copies:
            return copies[n]
        c = type(n)(n.val)
        copies[n] = c
        c.neighbors = [walk(x) for x in n.neighbors]
        return c
    out = walk(node)
    assert out is not node
    return out
`;
  assert.deepEqual(passed(runPythonTests(clone, 'clone_graph', [{ input: { adj_list: [[2, 4], [1, 3], [2, 4], [1, 3]] }, expected: [[2, 4], [1, 3], [2, 4], [1, 3]] }],
    { adapters: { args: { adj_list: 'graph' }, returns: 'graph' } })), [true]);
  const depth = 'def max_depth(root):\n    return 0 if root is None else 1 + max(max_depth(root.left), max_depth(root.right))\n';
  assert.deepEqual(passed(runPythonTests(depth, 'max_depth', [{ input: { root: [3, 9, 20, null, null, 15, 7] }, expected: 3 }], { adapters: { args: { root: 'tree' } } })), [true]);
});

test('tuples, sets and int keys compare in JSON terms; floats use a tolerance; bools stay strict', () => {
  const code = 'def f(kind):\n    return {"tuple": [(0, 2, ["aa"])], "set": {3, 1, 2}, "keys": {1: "a"}, "float": 0.1 + 0.2, "bool": 1}[kind]\n';
  const tests = [
    { input: { kind: 'tuple' }, expected: [[0, 2, ['aa']]] },
    { input: { kind: 'set' }, expected: [1, 2, 3] },
    { input: { kind: 'keys' }, expected: { 1: 'a' } },
    { input: { kind: 'float' }, expected: 0.3 },
    { input: { kind: 'bool' }, expected: true },
  ];
  assert.deepEqual(passed(runPythonTests(code, 'f', tests)), [true, true, true, true, false]);
});

test('expected errors work for functions and for single operations, and a wrong error still fails', () => {
  const fnCode = 'def parse(s):\n    if not s:\n        raise ValueError("empty")\n    return int(s)\n';
  assert.deepEqual(passed(runPythonTests(fnCode, 'parse', [
    { input: { s: '' }, expected: { raises: 'ValueError' } },
    { input: { s: '' }, expected: { raises: 'Exception' } }, // a base class matches too
    { input: { s: '7' }, expected: { raises: 'ValueError' } },
    { input: { s: '' }, expected: { raises: 'KeyError' } },
  ])), [true, true, false, false]);
  const cls = `
class Sheet:
    def __init__(self):
        self.cells = {}
    def set_cell(self, cell, value):
        if value == "=" + cell:
            raise ValueError("cycle")
        self.cells[cell] = int(value)
    def get_cell(self, cell):
        return self.cells.get(cell, 0)
`;
  const r = runPythonTests(cls, 'Sheet', [
    { input: { operations: [['set_cell', 'A1', '5'], ['set_cell', 'A1', '=A1'], ['get_cell', 'A1']] }, expected: [null, { raises: 'ValueError' }, 5] },
    { input: { operations: [['set_cell', 'A1', '=A1']] }, expected: [null] },
  ]);
  assert.deepEqual(passed(r), [true, false]);
  assert.match(r.results[1].error, /operation 1 \(set_cell\) raised ValueError: cycle/);
});

test('class operation outputs are positional: reordered outputs do not pass', () => {
  const cls = 'class Q:\n    def __init__(self):\n        self.n = 0\n    def bump(self):\n        self.n += 1\n        return 3 - self.n\n';
  assert.deepEqual(passed(runPythonTests(cls, 'Q', [{ input: { operations: [['bump'], ['bump']] }, expected: [1, 2] }])), [false]);
  // Plain function results may still come back in any order.
  assert.deepEqual(passed(runPythonTests('def f():\n    return [3, 1, 2]\n', 'f', [{ input: {}, expected: [1, 2, 3] }])), [true]);
});

test('load errors and bad adapters are reported, not thrown', () => {
  assert.match(runPythonTests('def f(:\n', 'f', []).error, /SyntaxError/);
  assert.match(runPythonTests('x = 1\n', 'f', []).error, /not defined/);
  assert.equal(adaptersError(null), null);
  assert.equal(adaptersError({ args: { root: 'tree' }, returns: 'list' }), null);
  assert.match(adaptersError({ args: { root: 'heap' } }), /tree, list, or graph/);
  assert.match(adaptersError({ output: 'tree' }), /unknown keys/);
});
