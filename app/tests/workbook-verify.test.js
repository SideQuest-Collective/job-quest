// app/tests/workbook-verify.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { parseFile } = require('../lib/workbook/parse');
const { verifyQuestion, verifyQuestions } = require('../lib/workbook/verify');

const HAS_PY = !spawnSync('python3', ['--version']).error;
const CH = '@@chapter id=c\n## In plain English\n\n## Key takeaways\n\n';

function codeQ(tests, code) {
  const text = `${CH}@@q id=q1 type=code diff=1 chapter=c\np\n@@rubric\n- r\n${tests === null ? '' : `@@tests\n\`\`\`json\n${tests}\n\`\`\`\n`}@@answer\n\`\`\`python\n${code}\n\`\`\`\n`;
  return parseFile(text, 'a.md').questions[0];
}

test('passing function cases', { skip: !HAS_PY }, async () => {
  const r = await verifyQuestion(codeQ('{"entry":"pair","cases":[{"args":[1],"expect":[1,2]},{"args":[0.1],"expect":[0.1,1.1]}]}', 'def pair(x):\n    return (x, x + 1)'));
  assert.deepEqual(r, { qid: 'q1', sandbox: process.platform === 'darwin' && HAS_SANDBOX ? 'sandbox-exec' : r.sandbox, pass: true, failures: [] });
});

test('failing case reports expected and actual', { skip: !HAS_PY }, async () => {
  const r = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[1],"expect":2},{"args":[2],"expect":3}]}', 'def f(x):\n    return x + 2'));
  assert.equal(r.pass, false);
  assert.deepEqual(r.failures, [{ case: 0, expected: 2, actual: '3' }, { case: 1, expected: 3, actual: '4' }]);
});

test('exceptions are failures, class calls work, sets compare as sorted lists', { skip: !HAS_PY }, async () => {
  const boom = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}', 'def f():\n    raise ValueError("nope")'));
  assert.match(boom.failures[0].error, /ValueError: nope/);
  const cls = await verifyQuestion(codeQ('{"entry":"Bag","calls":[["__init__",[2],null],["add",[3],null],["items",[],[2,3]]]}',
    'class Bag:\n    def __init__(self, x):\n        self.s = {x}\n    def add(self, y):\n        self.s.add(y)\n    def items(self):\n        return self.s'));
  assert.deepEqual(cls, { qid: 'q1', sandbox: process.platform === 'darwin' && HAS_SANDBOX ? 'sandbox-exec' : cls.sandbox, pass: true, failures: [] });
});

test('an infinite loop times out', { skip: !HAS_PY }, async () => {
  const r = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}', 'def f():\n    while True:\n        pass'), { timeoutMs: 500 });
  assert.equal(r.pass, false);
  assert.match(r.failures[0].error, /timed out after 500 ms/);
});

test('stdout exceeding 1 MiB fails well before the timeout', { skip: !HAS_PY }, async () => {
  const start = performance.now();
  const r = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}',
    'def f():\n    for _ in range(2048):\n        print("x" * 1024, flush=True)\n    while True:\n        pass'));
  assert.equal(r.pass, false);
  assert.match(r.failures[0].error, /output limit exceeded/);
  assert.ok(performance.now() - start < 3000, 'output limit should stop verification within 3 s');
});

test('top-level stdout without a newline does not corrupt the result', { skip: !HAS_PY }, async () => {
  const r = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}',
    'print("x", end="")\ndef f():\n    return 1'));
  assert.deepEqual(r, { qid: 'q1', sandbox: process.platform === 'darwin' && HAS_SANDBOX ? 'sandbox-exec' : r.sandbox, pass: true, failures: [] });
});

test('missing python marks the question unverified, not failed', async () => {
  const r = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}', 'def f():\n    return 1'), { python: '/nonexistent/python3' });
  assert.equal(r.unverified, true);
  assert.equal(r.pass, false);
  assert.match(r.reason, /python not found/);
});

test('missing @@tests is unverified; a reference without entry fails', async () => {
  const r = await verifyQuestion(codeQ(null, 'def f():\n    return 1'));
  assert.equal(r.unverified, true);
  const noRef = await verifyQuestion(codeQ('{"entry":"g","cases":[{"args":[],"expect":1}]}', 'def f():\n    return 1'));
  assert.equal(noRef.pass, false);
  assert.match(noRef.failures[0].error, /defines g/);
});

test('verifyQuestions only runs code questions', { skip: !HAS_PY }, async () => {
  const qs = parseFile(`${CH}@@q id=m type=mcq diff=1 chapter=c\np\n@@choices\n- [x] a\n- [ ] b\n- [ ] c\n@@answer\na\n`, 'a.md').questions;
  qs.push(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}', 'def f():\n    return 1'));
  const r = await verifyQuestions(qs);
  assert.deepEqual(r.map((x) => [x.qid, x.pass]), [['q1', true]]);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HAS_SANDBOX = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
for (const [name, body] of [
  ['socket connection', "import socket\n    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\n    s.connect(('127.0.0.1', 9))\n    s.close()"],
  ['home read', `open(${JSON.stringify(path.join(__dirname, '..', 'package.json'))}).read()`],
]) {
  test(`fix round 1: verification denies ${name}`, { skip: !HAS_SANDBOX || !HAS_PY }, async () => {
    const r = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}', `def f():\n    ${body}\n    return 1`));
    assert.equal(r.pass, false);
    assert.equal(r.sandbox, 'sandbox-exec');
    assert.equal(r.failures[0].case, 0, JSON.stringify(r));
    assert.match(r.failures[0].error, /PermissionError|Operation not permitted/);
  });
}

test('verification selects Linux network isolation or warns about an explicit fallback', () => {
  const { verificationSandbox } = require('../lib/workbook/verify');
  const warnings = [];
  const options = { platform: 'linux', find: () => '/usr/bin/unshare', probe: () => true, warn: message => warnings.push(message) };
  assert.deepEqual(verificationSandbox(os.tmpdir(), options), { sandbox: 'unshare', command: '/usr/bin/unshare', args: ['-n', '--'] });
  assert.deepEqual(verificationSandbox(os.tmpdir(), { ...options, probe: () => false }), { sandbox: 'none', args: [] });
  assert.deepEqual(verificationSandbox(os.tmpdir(), { ...options, find: () => null }), { sandbox: 'none', args: [] });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(w => /sandbox: none/.test(w)));
});

test('verification denies writes outside its temp directory', { skip: !HAS_SANDBOX || !HAS_PY }, async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'target');
  const r = await verifyQuestion(codeQ('{"entry":"f","cases":[{"args":[],"expect":1}]}', `def f():\n    open(${JSON.stringify(target)}, "w").write("bad")\n    return 1`));
  assert.equal(r.pass, false);
  assert.equal(r.failures[0].case, 0, JSON.stringify(r));
  assert.match(r.failures[0].error, /PermissionError/);
  assert.equal(fs.existsSync(target), false);
});

test('fix round 3: Darwin profile permits a home interpreter and caches its resolved prefix', (t) => {
  const { verificationSandbox } = require('../lib/workbook/verify');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-python-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const scratch = path.join(root, 'scratch');
  const prefix = path.join(home, 'venv');
  const interpreter = path.join(home, 'python-real');
  const python = path.join(home, 'python3');
  const count = path.join(root, 'probes');
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(scratch);
  fs.writeFileSync(interpreter, `#!/bin/sh\necho probe >> '${count}'\nprintf '%s\\n' '${prefix}'\n`, { mode: 0o755 });
  fs.symlinkSync(interpreter, python);
  const options = { platform: 'darwin', home, python, find: () => '/usr/bin/sandbox-exec' };
  const sandbox = verificationSandbox(scratch, options);
  assert.equal(sandbox.sandbox, 'sandbox-exec');
  assert.ok(sandbox.args[1].includes(`(allow file-read* (subpath ${JSON.stringify(fs.realpathSync(prefix))}))`));
  assert.ok(sandbox.args[1].includes(`(allow file-read* (literal ${JSON.stringify(fs.realpathSync(interpreter))}))`));
  assert.deepEqual(verificationSandbox(scratch, options), sandbox);
  assert.equal(fs.readFileSync(count, 'utf8'), 'probe\n');
});

test('fix round 3: missing home or unresolved Python prefix warns and falls back without throwing', (t) => {
  const { verificationSandbox } = require('../lib/workbook/verify');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-python-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const badPython = path.join(root, 'python3');
  fs.writeFileSync(badPython, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const [home, python] of [[path.join(root, 'missing-home'), 'python3'], [root, badPython], [root, path.join(root, 'missing-python')]]) {
    const warnings = [];
    const result = verificationSandbox(root, { platform: 'darwin', home, python,
      find: () => '/usr/bin/sandbox-exec', warn: message => warnings.push(message) });
    assert.deepEqual(result, { sandbox: 'none', args: [] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sandbox: none/);
  }
});
