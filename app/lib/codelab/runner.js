// app/lib/codelab/runner.js
// Runs Python against Code Lab test cases through harness.py (see its header for the test shapes).
const path = require('path');
const { execFileSync } = require('child_process');

const HARNESS = path.join(__dirname, 'harness.py');
const ADAPTER_KINDS = ['tree', 'list', 'graph'];

function runPythonTests(code, functionName, testCases, { adapters = null, timeoutMs = 10000 } = {}) {
  try {
    const output = execFileSync('python3', [HARNESS], {
      input: JSON.stringify({ code, functionName, testCases, adapters }),
      encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(output.trim());
  } catch (err) {
    const stderr = String(err.stderr || err.message || '').trim();
    const errorText = [err.stderr, err.message, err.code, err.signal].filter(Boolean).join('\n');
    const timedOut = /timed out|timeout|ETIMEDOUT|SIGTERM/i.test(errorText);
    return {
      error: timedOut ? `Execution timed out after ${Math.round(timeoutMs / 1000)} seconds` : 'Code Lab could not start the Python runner',
      errorSource: 'runtime',
      errorTitle: 'Code Lab failed to run your code',
      errorDetails: stderr || 'The local runner failed before your code could be evaluated.',
      results: [],
    };
  }
}

// Returns an error message, or null when the adapters field is absent or well formed.
function adaptersError(adapters) {
  if (adapters == null) return null;
  if (typeof adapters !== 'object' || Array.isArray(adapters)) return 'adapters must be an object';
  const extra = Object.keys(adapters).filter((k) => k !== 'args' && k !== 'returns');
  if (extra.length) return `adapters has unknown keys: ${extra.join(', ')}`;
  if (adapters.args != null) {
    if (typeof adapters.args !== 'object' || Array.isArray(adapters.args)) return 'adapters.args must map parameter names to tree, list, or graph';
    for (const [k, v] of Object.entries(adapters.args)) if (!ADAPTER_KINDS.includes(v)) return `adapters.args.${k} must be tree, list, or graph`;
  }
  if (adapters.returns != null && !ADAPTER_KINDS.includes(adapters.returns)) return 'adapters.returns must be tree, list, or graph';
  return null;
}

module.exports = { runPythonTests, adaptersError, ADAPTER_KINDS };

const LINT = path.join(__dirname, 'lint.py');

// Structural check of starter code against tests (no execution). Returns { [id]: [issue, ...] } for every problem.
function lintProblems(problems) {
  const out = execFileSync('python3', [LINT], { input: JSON.stringify(problems), encoding: 'utf-8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  return Object.fromEntries(JSON.parse(out).map((r) => [r.id, r.issues]));
}

module.exports.lintProblems = lintProblems;
