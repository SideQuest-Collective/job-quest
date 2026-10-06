// app/lib/workbook/verify.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parseTests, referenceSolution } = require('./parse');

const STDOUT_LIMIT_BYTES = 1048576;
const STDERR_TAIL_BYTES = 65536;

function executable(command) {
  for (const file of command.includes('/') ? [command] : (process.env.PATH || '/usr/bin:/bin').split(path.delimiter).map((p) => path.join(p, command))) {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch {}
  }
  return null;
}

let unshareAvailable;
let warned = false;
const pythonRuntimes = new Map();
function pythonRuntime(python) {
  const key = JSON.stringify([python, process.env.PATH]);
  if (!pythonRuntimes.has(key)) {
    let runtime = null;
    try {
      const interpreter = executable(python);
      if (!interpreter) throw new Error('python not found');
      // Probe trusted interpreter metadata once, before applying the sandbox.
      const result = spawnSync(python, ['-c', 'import sys;print(sys.prefix)'], { encoding: 'utf8', timeout: 5000 });
      if (result.error || result.status !== 0 || !path.isAbsolute(result.stdout.trim())) throw new Error('python prefix unavailable');
      runtime = { interpreter, prefix: fs.realpathSync(result.stdout.trim()) };
    } catch {}
    pythonRuntimes.set(key, runtime);
  }
  return pythonRuntimes.get(key);
}

function verificationSandbox(dir, { platform = process.platform, home = os.homedir(), find = executable,
  python = process.env.JOB_QUEST_PYTHON || 'python3',
  probe = (command) => spawnSync(command, ['-n', 'true'], { timeout: 1000 }).status === 0,
  warn = console.warn } = {}) {
  if (platform === 'darwin' && find('/usr/bin/sandbox-exec')) {
    try {
      const quote = (value) => JSON.stringify(value);
      const scratch = quote(fs.realpathSync(dir));
      const userHome = quote(fs.realpathSync(home));
      const runtime = pythonRuntime(python);
      if (!runtime) throw new Error('python runtime unavailable');
      const profile = `(version 1) (allow default)
        (deny network*)
        (deny file-write* (require-not (subpath ${scratch})))
        (deny file-read* (require-all (subpath ${userHome}) (require-not (subpath ${scratch}))))
        (allow file-read* (subpath ${quote(runtime.prefix)}))
        (allow file-read* (literal ${quote(runtime.interpreter)}))`;
      return { sandbox: 'sandbox-exec', command: '/usr/bin/sandbox-exec', args: ['-p', profile] };
    } catch {
      // Missing HOME or interpreter metadata must not abort verification setup.
    }
  }
  if (platform === 'linux') {
    const command = find('unshare');
    if (command && probe(command)) return { sandbox: 'unshare', command, args: ['-n', '--'] };
  }
  warn('Workbook verification is running without an OS sandbox (sandbox: none).');
  return { sandbox: 'none', args: [] };
}

const HARNESS = [
  'import json, math, sys, resource',
  'try:',
  '    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))',
  'except (ValueError, OSError):',
  '    pass',
  'spec = json.load(open(sys.argv[1]))',
  'def norm(v):',
  '    if isinstance(v, (list, tuple)):',
  '        return [norm(x) for x in v]',
  '    if isinstance(v, (set, frozenset)):',
  '        return sorted((norm(x) for x in v), key=repr)',
  '    if isinstance(v, dict):',
  '        return {str(k): norm(x) for k, x in v.items()}',
  '    return v',
  'def same(actual, expected):',
  '    if actual == expected:',
  '        return True',
  '    a = norm(actual)',
  '    if isinstance(a, float) and isinstance(expected, (int, float)) and not isinstance(expected, bool):',
  '        return math.isclose(a, expected, rel_tol=1e-9, abs_tol=1e-12)',
  '    if isinstance(a, list) and isinstance(expected, list) and len(a) == len(expected):',
  '        return all(same(x, y) for x, y in zip(a, expected))',
  '    return a == expected',
  'out = {"failures": []}',
  'def write_result():',
  '    with open("result.json", "w") as result:',
  '        json.dump(out, result, default=repr)',
  'def fail(case, expected=None, actual=None, error=None):',
  '    f = {"case": case, "expected": expected}',
  '    if error is not None:',
  '        f["error"] = error',
  '    else:',
  '        f["actual"] = repr(actual)',
  '    out["failures"].append(f)',
  'g = {"__name__": "__workbook__"}',
  'try:',
  '    exec(spec["code"], g)',
  'except Exception as e:',
  '    fail(-1, error="reference raised while loading: %s: %s" % (type(e).__name__, e))',
  '    write_result()',
  '    sys.exit(0)',
  'entry = spec["entry"]',
  'if entry not in g:',
  '    fail(-1, error="reference does not define %s" % entry)',
  'elif "cases" in spec:',
  '    for i, c in enumerate(spec["cases"]):',
  '        try:',
  '            actual = g[entry](*c["args"])',
  '            if not same(actual, c["expect"]):',
  '                fail(i, c["expect"], actual)',
  '        except Exception as e:',
  '            fail(i, c["expect"], error="%s: %s" % (type(e).__name__, e))',
  'else:',
  '    calls = list(spec["calls"])',
  '    offset = 0',
  '    obj = None',
  '    try:',
  '        if calls and calls[0][0] == "__init__":',
  '            obj = g[entry](*calls[0][1])',
  '            calls = calls[1:]',
  '            offset = 1',
  '        else:',
  '            obj = g[entry]()',
  '    except Exception as e:',
  '        fail(0, error="constructor raised %s: %s" % (type(e).__name__, e))',
  '        calls = []',
  '    for i, call in enumerate(calls):',
  '        method, args, expected = call',
  '        try:',
  '            actual = getattr(obj, method)(*args)',
  '            if not same(actual, expected):',
  '                fail(i + offset, expected, actual)',
  '        except Exception as e:',
  '            fail(i + offset, expected, error="%s: %s" % (type(e).__name__, e))',
  'write_result()',
].join('\n') + '\n';

function verifyQuestion(q, opts = {}) {
  const python = opts.python || process.env.JOB_QUEST_PYTHON || 'python3';
  const timeoutMs = opts.timeoutMs || 10000;
  const qid = q.id;
  const t = parseTests('tests' in (q.sections || {}) ? q.tests : null);
  if (!t.ok) return Promise.resolve({ qid, pass: false, unverified: true, reason: t.error, failures: [] });
  const code = referenceSolution(q.answer, t.value.entry);
  if (!code) {
    return Promise.resolve({ qid, pass: false, failures: [{ case: -1, error: `no python block in @@answer defines ${t.value.entry}` }] });
  }
  const pythonPath = executable(python);
  if (!pythonPath) return Promise.resolve({ qid, pass: false, unverified: true, reason: `python not found (${python})`, failures: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-verify-'));
  const confinement = verificationSandbox(dir, {
    python,
    probe: (command) => {
      if (unshareAvailable === undefined) unshareAvailable = spawnSync(command, ['-n', 'true'], { timeout: 1000 }).status === 0;
      return unshareAvailable;
    },
    warn: (message) => { if (!warned) { console.warn(message); warned = true; } },
  });
  fs.writeFileSync(path.join(dir, 'harness.py'), HARNESS);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ ...t.value, code }));
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputLimitExceeded = false;
    let timedOut = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ qid, sandbox: confinement.sandbox, ...r });
    };
    let child;
    try {
      child = spawn(confinement.command || pythonPath, [...confinement.args, ...(confinement.command ? [pythonPath] : []), '-I', 'harness.py', 'spec.json'], {
        cwd: dir,
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dir, PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      done({ pass: false, unverified: true, reason: `python not found (${python}): ${err.message}`, failures: [] });
      return;
    }
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (outputLimitExceeded) return;
      const remaining = STDOUT_LIMIT_BYTES - stdout.length;
      stdout = Buffer.concat([stdout, d.subarray(0, remaining)]);
      if (d.length > remaining) {
        outputLimitExceeded = true;
        clearTimeout(timer);
        killGroup();
      }
    });
    child.stderr.on('data', (d) => {
      stderr = Buffer.concat([stderr, d]).subarray(-STDERR_TAIL_BYTES);
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') done({ pass: false, unverified: true, reason: `python not found (${python})`, failures: [] });
      else done({ pass: false, failures: [{ case: -1, error: String(err.message || err) }] });
    });
    child.on('close', (code) => {
      if (outputLimitExceeded) { done({ pass: false, failures: [{ case: -1, error: 'output limit exceeded' }] }); return; }
      if (timedOut) { done({ pass: false, failures: [{ case: -1, error: `timed out after ${timeoutMs} ms` }] }); return; }
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch {}
      if (!parsed || !Array.isArray(parsed.failures)) {
        done({ pass: false, failures: [{ case: -1, error: `harness crashed (exit ${code}): ${stderr.toString('utf8').slice(-500)}` }] });
        return;
      }
      done({ pass: parsed.failures.length === 0, failures: parsed.failures });
    });
  });
}

async function verifyQuestions(questions, opts = {}) {
  const out = [];
  for (const q of questions) if (q.type === 'code') out.push(await verifyQuestion(q, opts));
  return out;
}

module.exports = { verifyQuestion, verifyQuestions, HARNESS, verificationSandbox };
