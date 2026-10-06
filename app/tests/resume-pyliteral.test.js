// app/tests/resume-pyliteral.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAssignments, PyLiteralError } = require('../lib/resume/pyliteral');

test('parses strings, raw strings, implicit concatenation, numbers and constants', () => {
  const env = parseAssignments([
    'A = "x\\ty"',
    'B = r"Grocery \\& Ads"',
    'C = ("one " "two")',
    'D = [1, 2.5, -3, True, False, None]',
    "E = 'single'",
  ].join('\n'));
  assert.equal(env.A, 'x\ty');
  assert.equal(env.B, 'Grocery \\& Ads');
  assert.equal(env.C, 'one two');
  assert.deepEqual(env.D, [1, 2.5, -3, true, false, null]);
  assert.equal(env.E, 'single');
});

test('parses tuples, lists, dict literals, dict() calls and multi-line values', () => {
  const env = parseAssignments([
    'T = ("Name", "React, Node.js",',
    ' ["first bullet",',
    '  "second bullet"])',
    'ONE = ("solo",)',
    'D = {',
    ' "a": [1, 2],',
    ' "b": dict(x="1", y=[("k", "v")]),',
    '}',
  ].join('\n'));
  assert.deepEqual(env.T, ['Name', 'React, Node.js', ['first bullet', 'second bullet']]);
  assert.deepEqual(env.ONE, ['solo']);
  assert.deepEqual(env.D, { a: [1, 2], b: { x: '1', y: [['k', 'v']] } });
});

test('resolves earlier names, subscripts, dict(copy) and subscript assignment', () => {
  const env = parseAssignments([
    'BASE = ("P", "TS", ["b"])',
    'V = {"one": dict(head="H1", projects=[BASE])}',
    'V["two"] = dict(V["one"])',
    'V["two"]["head"] = "H2"',
    'V["three"] = dict(head="H3", projects=V["one"]["projects"])',
  ].join('\n'));
  assert.equal(env.V.one.head, 'H1');
  assert.equal(env.V.two.head, 'H2');
  assert.deepEqual(env.V.two.projects, [['P', 'TS', ['b']]]);
  assert.deepEqual(env.V.three.projects, env.V.one.projects);
  assert.deepEqual(Object.keys(env.V), ['one', 'two', 'three']);
});

test('comments and blank lines are ignored', () => {
  const env = parseAssignments('# header\n\nX = [1, # inline\n 2]\n');
  assert.deepEqual(env.X, [1, 2]);
});

test('rejects anything that is not a literal assignment (nothing is executed)', () => {
  assert.throws(() => parseAssignments('import os\n'), /unsupported statement at line 1/);
  assert.throws(() => parseAssignments('X = __import__("os")\n'), /unknown name __import__ at line 1/);
  assert.throws(() => parseAssignments('X = 1 + 2\n'), /unsupported character "\+"/);
  assert.throws(() => parseAssignments('X = "open\n'), PyLiteralError);
  assert.throws(() => parseAssignments('X = Y\n'), /unknown name Y at line 1/);
});

test('only-mode evaluates the named assignments and skips other code', () => {
  const src = [
    'import subprocess, re',
    'JD = {',
    ' "A": {"title": "Eng", "kw": ["Python", "SQL|Postgres"]},',
    ' "B": None,',
    '}',
    'TELLS = ["leverag", "robust"]',
    'def grade(name):',
    '    x = name + 1',
    '    return x',
    'JD["B"] = JD["A"]',
    'for n in []:',
    '    print(n)',
  ].join('\n');
  const env = parseAssignments(src, { only: ['JD', 'TELLS'] });
  assert.deepEqual(env.TELLS, ['leverag', 'robust']);
  assert.equal(env.JD.B.title, 'Eng');
  assert.equal(env.grade, undefined);
});
