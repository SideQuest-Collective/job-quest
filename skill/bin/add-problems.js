#!/usr/bin/env node
// skill/bin/add-problems.js — the one supported way to add Code Lab problems (the daily intel agent uses it too).
// Each problem must pass the structural check (lib/codelab/lint.py) and carry a referenceSolution that passes
// every test in Code Lab's runner. All-or-nothing: on any failure nothing is written. Prints one JSON value.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addProblems } = require('../../app/lib/prep/problems');
const { runPythonTests, lintProblems } = require('../../app/lib/codelab/runner');

const USAGE = 'Usage: add-problems <problems.json> [--data-dir <dir>]   (file holds {"problems": [...]} or a bare array)';

function main(argv = process.argv.slice(2), out = process.stdout) {
  const fail = (msg, code = 1) => { out.write(`${JSON.stringify({ error: msg })}\n`); return code; };
  let file = null; let dataDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') { dataDir = argv[++i]; if (!dataDir) return fail(`--data-dir needs a value. ${USAGE}`, 2); }
    else if (!file && !argv[i].startsWith('--')) file = argv[i];
    else return fail(`unexpected argument ${argv[i]}. ${USAGE}`, 2);
  }
  if (!file) return fail(USAGE, 2);
  let body;
  try { body = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (err) { return fail(`could not read ${file}: ${err.message}`); }
  if (Array.isArray(body)) body = { problems: body };
  const raw = dataDir || process.env.DATA_DIR || path.join(os.homedir(), '.job-quest', 'data');
  const dir = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
  try {
    const result = addProblems(dir, body, { runTests: runPythonTests, lint: lintProblems });
    out.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
