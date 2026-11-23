const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { extractResume } = require('../lib/resume/import-file');
const { withServer, post, put } = require('./helpers/server');
const { loadMaster, tmpDir } = require('./helpers/resume-fixtures');
const { minimalPdf } = require('./helpers/minimal-pdf');

test('concurrent imports cannot mix selected source prompts, and failed AI preserves the master', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'resume.txt');
  fs.writeFileSync(file, 'Jamie Example\nSenior Engineer\nBuilt reliable services.');
  const { createResumeService } = require('../lib/resume/pipeline');
  const { writeMaster } = require('../lib/resume/master');
  writeMaster(dir, loadMaster());
  const before = fs.readFileSync(path.join(dir, 'resume', 'master.json'), 'utf8');
  let finish;
  const svc = createResumeService({ dataDir: dir, deps: {runAgent: () => new Promise(resolve => {finish = resolve;})} });
  const pending = svc.importFile(file);
  await assert.rejects(svc.importFile(file), /already running/);
  finish({ok:false});
  await assert.rejects(pending, /converter failed/);
  assert.equal(fs.readFileSync(path.join(dir, 'resume', 'master.json'), 'utf8'), before);
});

test('both import endpoints share one lock, including .tex through import-file, and release it after completion', async () => {
  const dir = tmpDir();
  const text = path.join(dir, 'resume.txt'), tex = path.join(dir, 'resume.tex');
  fs.writeFileSync(text, 'Jamie Example\nSenior Engineer\nBuilt reliable services.');
  fs.writeFileSync(tex, String.raw`\documentclass{article}\begin{document}Jamie Example\end{document}`);
  const { createResumeService } = require('../lib/resume/pipeline');
  for (const first of ['text', 'legacy', 'tex']) {
    let finish;
    const svc = createResumeService({ dataDir: dir, deps: { runAgent: () => new Promise(resolve => { finish = resolve; }) } });
    const pending = first === 'legacy' ? svc.importLatex(tex) : svc.importFile(first === 'tex' ? tex : text);
    await assert.rejects(svc.importFile(text), /already running/);
    await assert.rejects(svc.importFile(tex), /already running/);
    await assert.rejects(svc.importLatex(tex), /already running/);
    finish({ ok:true, stdout: JSON.stringify(loadMaster()) });
    assert.deepEqual((await pending).errors, []);
    const next = svc.importLatex(tex);
    finish({ok:true, stdout: JSON.stringify(loadMaster())});
    assert.deepEqual((await next).errors, []);
  }
});

test('PDF extraction reads real text and rejects empty/scanned documents before AI', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'resume.pdf');
  fs.writeFileSync(file, minimalPdf(['Jamie Example', 'Senior Engineer', 'Built reliable services.']));
  assert.equal((await extractResume(file)).text, 'Jamie Example\nSenior Engineer\nBuilt reliable services.');
  fs.writeFileSync(file, minimalPdf([]));
  await assert.rejects(extractResume(file), /No readable resume text/);
});

test('Word extraction preserves paragraphs, table cells and escaped characters', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'resume.docx');
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document><w:p><w:r><w:t>Jamie Example &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>Engineer &lt;Platform&gt;</w:t></w:r></w:p><w:tr><w:tc><w:p><w:t>Python</w:t></w:p></w:tc><w:tc><w:p><w:t>SQL</w:t></w:p></w:tc></w:tr></w:document>'));
  zip.writeZip(file);
  const result = await extractResume(file);
  assert.match(result.text, /Jamie Example & Co\nEngineer <Platform>/);
  assert.match(result.text, /Python\n\tSQL/);
  assert.equal(result.format, 'docx');
  fs.writeFileSync(path.join(dir, 'blank.txt'), '');
  await assert.rejects(extractResume(path.join(dir, 'blank.txt')), /No readable resume text/);
  fs.writeFileSync(path.join(dir, 'bad.docx'), 'not a zip');
  await assert.rejects(extractResume(path.join(dir, 'bad.docx')), /Could not read this resume/);
  await assert.rejects(extractResume(path.join(dir, 'legacy.doc')), /Save older .doc files/);
});

test('uploaded ordinary resume proposes review without overwriting originals/master; saved master exports all primary bullets to LaTeX', async () => {
  const dir = tmpDir();
  const fakeDir = path.join(dir, 'resume', 'import', '.fake');
  fs.mkdirSync(fakeDir, { recursive: true });
  const master = loadMaster();
  fs.writeFileSync(path.join(fakeDir, 'resume-to-master.js'), `module.exports = async ({prompt,fs,path,cwd}) => { fs.writeFileSync(path.join(cwd,'seen-prompt.txt'),prompt); process.stdout.write(${JSON.stringify(JSON.stringify(master))}); };`);
  await withServer(dir, async base => {
    const upload = async text => (await (await fetch(`${base}/api/resume/upload`, post({ filename: 'resume.txt', data: Buffer.from(text).toString('base64') }))).json());
    assert.equal((await upload('Jamie Example\nEngineer\nBuilt APIs with Python.')).filename, 'resume.txt');
    assert.equal((await upload('Jamie Example\nSecond independent original.')).filename, 'resume (1).txt');
    assert.match(fs.readFileSync(path.join(dir,'resume-files','resume.txt'),'utf8'), /Built APIs/);
    const draft = await fetch(`${base}/api/resume/master/import-file`, post({filename:'resume.txt'}));
    assert.equal(draft.status, 200);
    const body = await draft.json();
    assert.deepEqual(body.errors, []);
    assert.equal(body.source.format, 'txt');
    assert.match(fs.readFileSync(path.join(dir,'resume','import','seen-prompt.txt'),'utf8'), /Built APIs with Python/);
    assert.equal(fs.existsSync(path.join(dir,'resume','master.json')), false);
    assert.equal((await fetch(`${base}/api/resume/master/latex`)).status, 409);
    assert.equal((await fetch(`${base}/api/resume/master/import-file`, post({filename:'../../outside.txt'}))).status, 400);
    assert.equal((await fetch(`${base}/api/resume/master/import-file`, post({filename:'missing.txt'}))).status, 404);
    const save = await fetch(`${base}/api/resume/master`, put(body.proposed));
    assert.equal(save.status, 200);
    const exported = await fetch(`${base}/api/resume/master/latex`);
    assert.equal(exported.status, 200);
    const tex = await exported.text();
    assert.match(tex, /\\documentclass/);
    const { latexEscape } = require('../lib/resume/render');
    for (const employer of master.experience) for (const role of employer.roles) for (const bullet of role.bullets.filter(b => !b.variantOf)) assert.ok(tex.includes(latexEscape(bullet.text)), `export includes ${bullet.id}`);
    for (const project of master.projects) for (const bullet of project.bullets.filter(b => !b.variantOf)) assert.ok(tex.includes(latexEscape(bullet.text)));
  });
});
