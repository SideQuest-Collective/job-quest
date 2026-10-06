#!/usr/bin/env node
// skill/bin/import-resume.js — import a content.py/build.py/LaTeX resume source, or a drafted
// master JSON (--json), into master.json. Prints a diff against the current master.json; writes only with --write.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importPySource } = require('../../app/lib/resume/import-pysource');
const { readMaster, writeMaster, emptyMaster, assignIds, validateMaster } = require('../../app/lib/resume/master');
const { lineDiff } = require('../../app/lib/resume/diff');

const USAGE = 'Usage: import-resume --content <content.py> --tex <resume_cv.tex> [--build <build.py>] [--variant <name>] [--data-dir <dir>] [--write]\n       import-resume --json <master.json> [--data-dir <dir>] [--write]';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--write') a.write = true;
    else {
      if (!['--content', '--tex', '--build', '--variant', '--data-dir', '--json'].includes(k)) throw new Error(`Unknown flag: ${k}`);
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${k}`);
      a[k.slice(2)] = argv[++i];
    }
  }
  return a;
}

function main(argv = process.argv.slice(2), out = process.stdout, errOut = process.stderr) {
  let a;
  try { a = parseArgs(argv); }
  catch (err) { errOut.write(`${err.message}\n${USAGE}\n`); return 2; }
  if (a.json && (a.content || a.tex || a.build || a.variant)) { errOut.write(`--json cannot be combined with source flags\n${USAGE}\n`); return 2; }
  if (a.json) return importJson(a, out, errOut);
  if (!a.content || !a.tex) { errOut.write(`${USAGE}\n`); return 2; }
  const buildPath = a.build || path.join(path.dirname(a.content), 'build.py');
  const texDir = path.resolve(path.dirname(a.tex));
  const eduPath = path.join(texDir, 'cv-sections', 'education.tex');
  const readSection = (name) => {
    const file = path.join(texDir, 'cv-sections', `${name}.tex`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  };
  let selection;
  const master = importPySource({
    contentSrc: fs.readFileSync(a.content, 'utf-8'),
    buildSrc: fs.readFileSync(buildPath, 'utf-8'),
    texSrc: fs.readFileSync(a.tex, 'utf-8'),
    educationSrc: fs.existsSync(eduPath) ? fs.readFileSync(eduPath, 'utf-8') : '',
    summarySrc: a.variant ? null : readSection('summary'),
    skillsSrc: a.variant ? null : readSection('skills'),
    variant: a.variant || null,
    onSelection: (info) => { selection = info; },
  });
  const dataDir = resolveDataDir(a);
  for (const section of selection.missingSections) {
    errOut.write(`${section}.tex missing; falling back to first V entry "${selection.name}" for ${section}.\n`);
  }
  out.write(a.variant
    ? `Using variant "${selection.name}" (of ${selection.variantCount} variants)\n`
    : `Using base resume sections from ${texDir}\n`);
  return diffAndWrite(a, dataDir, master, out);
}

function resolveDataDir(a) {
  const rawDir = a['data-dir'] || process.env.DATA_DIR || path.join(os.homedir(), '.job-quest', 'data');
  return path.resolve(rawDir.replace(/^~(?=$|\/)/, os.homedir()));
}

// A master drafted by the assistant (or by hand) from a PDF, Word, Markdown or text resume.
// Missing top-level fields fall back to empty values; bullet IDs are assigned on write.
function importJson(a, out, errOut) {
  let v;
  try { v = JSON.parse(fs.readFileSync(a.json, 'utf-8')); }
  catch (err) { errOut.write(`import-resume: could not read ${a.json}: ${err.message}\n`); return 1; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errOut.write('import-resume: --json must contain a JSON object\n'); return 1; }
  const dataDir = resolveDataDir(a);
  const current = readMaster(dataDir);
  const base = emptyMaster();
  const master = { ...base, ...v, version: 1, contact: { ...base.contact, ...(v.contact || {}) } };
  const { errors } = validateMaster(assignIds(current, master));
  if (errors.length) {
    errOut.write(`import-resume: the drafted master is invalid:\n${errors.map((e) => `  ${e}`).join('\n')}\n`);
    return 1;
  }
  out.write(`Using drafted master ${path.resolve(a.json)}\n`);
  return diffAndWrite(a, dataDir, master, out);
}

function diffAndWrite(a, dataDir, master, out) {
  out.write(`${lineDiff(JSON.stringify(readMaster(dataDir), null, 2), JSON.stringify(master, null, 2))}\n`);
  if (!a.write) { out.write('\nDry run: nothing written. Re-run with --write to save master.json.\n'); return 0; }
  const saved = writeMaster(dataDir, master);
  const count = saved.experience.reduce((n, e) => n + e.roles.reduce((m, r) => m + r.bullets.length, 0), 0)
    + saved.projects.reduce((n, p) => n + p.bullets.length, 0);
  out.write(`\nWrote ${path.join(dataDir, 'resume', 'master.json')} (${count} bullets).\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (err) { process.stderr.write(`import-resume: ${err.message}\n`); process.exitCode = 1; }
}

module.exports = { main };
