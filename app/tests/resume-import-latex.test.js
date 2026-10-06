// app/tests/resume-import-latex.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { expandInputs } = require('../lib/resume/pipeline');
const { withServer, post } = require('./helpers/server');
const { loadMaster, tmpDir } = require('./helpers/resume-fixtures');

test('expandInputs inlines \\input files relative to the main file and skips comments and escapes', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'cv-sections'));
  fs.writeFileSync(path.join(dir, 'cv-sections', 'summary.tex'), '\\section{Summary}\nBuilds APIs.');
  fs.writeFileSync(path.join(dir, 'main.tex'), 'A\n\\input{cv-sections/summary.tex}\n% \\input{cv-sections/summary}\n\\input{../outside}\nB');
  assert.equal(expandInputs(path.join(dir, 'main.tex')), 'A\n\\section{Summary}\nBuilds APIs.\n% \\input{cv-sections/summary}\n\\input{../outside}\nB');
});

test('POST /api/resume/master/import-latex proposes a master and a diff without saving', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'resume-files', 'cv-sections'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resume-files', 'resume_cv.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{cv-sections/summary}\n\\end{document}\n');
  fs.writeFileSync(path.join(dir, 'resume-files', 'cv-sections', 'summary.tex'), '\\section{Summary}\nUNIQUE-SUMMARY-MARKER');
  const proposed = loadMaster();
  for (const e of proposed.experience) for (const r of e.roles) for (const b of r.bullets) delete b.id;
  for (const p of proposed.projects) for (const b of p.bullets) delete b.id;
  delete proposed.meta;
  const reply = `Here you go\n\`\`\`json\n${JSON.stringify(proposed)}\n\`\`\`\n`;
  const fakeDir = path.join(dir, 'resume', 'import', '.fake');
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(path.join(fakeDir, 'latex-to-master.js'), [
    'module.exports = async ({ cwd, fs, path, prompt }) => {',
    "  fs.writeFileSync(path.join(cwd, 'seen-prompt.txt'), prompt);",
    `  process.stdout.write(${JSON.stringify(reply)});`,
    '};',
  ].join('\n'));
  await withServer(dir, async (base) => {
    const res = await fetch(`${base}/api/resume/master/import-latex`, post({}));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.errors, []);
    assert.equal(body.proposed.experience[0].roles[0].bullets[0].id, 'exp.sr.1');
    assert.match(body.diff, /^\+ {3}"headline": "Senior Software Engineer \| Backend Systems & Data Platforms",$/m);
    assert.ok(fs.readFileSync(path.join(dir, 'resume', 'import', 'seen-prompt.txt'), 'utf-8').includes('UNIQUE-SUMMARY-MARKER'));
    assert.deepEqual((await (await fetch(`${base}/api/resume/master`)).json()).experience, [], 'nothing is saved until PUT');
    assert.equal((await fetch(`${base}/api/resume/master/import-latex`, post({ filename: '../../etc/passwd' }))).status, 403);
    assert.equal((await fetch(`${base}/api/resume/master/import-latex`, post({ filename: 'missing.tex' }))).status, 404);
  });
});
