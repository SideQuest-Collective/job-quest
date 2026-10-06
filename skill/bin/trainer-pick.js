#!/usr/bin/env node
// Deterministic workbook side of the interview trainer.
// Usage:
//   trainer-pick.js pick   --data-dir <dir> [--now <ISO>]
//   trainer-pick.js mcq    --data-dir <dir> --answer-file <file> [--now <ISO>]
//   trainer-pick.js record --data-dir <dir> --id <trainer question id> [--now <ISO>]
const fs = require('fs');
const path = require('path');
const trainer = require(path.join(__dirname, '..', '..', 'app', 'lib', 'workbook', 'trainer'));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

try {
  const cmd = process.argv[2];
  const dataDir = arg('data-dir');
  const nowArg = arg('now');
  if (nowArg && Number.isNaN(Date.parse(nowArg))) throw new Error('--now must be a valid date');
  const now = () => (nowArg ? new Date(nowArg) : new Date());
  if (!dataDir) throw new Error('--data-dir is required');
  let out;
  if (cmd === 'pick') {
    const { record, ...rest } = trainer.pickWorkbookQuestion(dataDir, { now });
    out = rest;
  } else if (cmd === 'mcq') {
    const file = arg('answer-file');
    if (!file) throw new Error('--answer-file is required');
    out = trainer.handleMcqReply(dataDir, fs.readFileSync(file, 'utf-8'), { now });
  } else if (cmd === 'record') {
    if (!arg('id')) throw new Error('--id is required');
    out = trainer.recordTrainerGrade(dataDir, arg('id'), { now });
  } else {
    throw new Error(`unknown command "${cmd}" (use pick, mcq, or record)`);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: String((err && err.message) || err) })}\n`);
  process.exit(1);
}
