// app/tests/resume-compile.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_TEMPLATE, renderTex, buildDocument, compileTex, findTectonic, ensureTemplate } = require('../lib/resume/render');
const { loadMaster, identityTailored, tmpDir } = require('./helpers/resume-fixtures');

const skip = findTectonic() ? false : 'tectonic not installed';
const template = () => fs.readFileSync(DEFAULT_TEMPLATE, 'utf-8');

test('ensureTemplate copies a usable resume-files template, else the default, and never overwrites', () => {
  const a = tmpDir();
  const pa = ensureTemplate(a);
  assert.equal(pa, path.join(a, 'resume', 'template', 'resume_cv.tex'));
  assert.equal(fs.readFileSync(pa, 'utf-8'), template());

  const b = tmpDir();
  const custom = template().replace('2C3E50', '123456');
  fs.mkdirSync(path.join(b, 'resume-files'), { recursive: true });
  fs.writeFileSync(path.join(b, 'resume-files', 'resume_cv.tex'), custom);
  assert.equal(fs.readFileSync(ensureTemplate(b), 'utf-8'), custom);

  const c = tmpDir();
  fs.mkdirSync(path.join(c, 'resume-files'), { recursive: true });
  fs.writeFileSync(path.join(c, 'resume-files', 'resume_cv.tex'), '\\documentclass{article}\\begin{document}x\\end{document}');
  assert.equal(fs.readFileSync(ensureTemplate(c), 'utf-8'), template());

  fs.writeFileSync(pa, custom);
  assert.equal(fs.readFileSync(ensureTemplate(a), 'utf-8'), custom);
});

test('a missing tectonic binary is a clean failure', async () => {
  const dir = tmpDir();
  const texPath = path.join(dir, 'x.tex');
  fs.writeFileSync(texPath, 'x');
  const r = await compileTex({ texPath, bin: path.join(dir, 'no-such-tectonic') });
  assert.equal(r.ok, false);
  assert.equal(r.pdfPath, null);
  assert.match(r.log, /tectonic not found/);
});

test('a non-executable tectonic binary reports the spawn error', async () => {
  const dir = tmpDir();
  const texPath = path.join(dir, 'resume.tex');
  const bin = path.join(dir, 'tectonic');
  fs.writeFileSync(texPath, 'x');
  fs.writeFileSync(bin, 'not executable', { mode: 0o600 });
  const r = await compileTex({ texPath, bin });
  assert.equal(r.ok, false);
  assert.equal(r.pdfPath, null);
  assert.match(r.log, /EACCES|permission/i);
});

test('rejects a non-.tex input without deleting it', () => {
  const dir = tmpDir();
  const texPath = path.join(dir, 'resume.txt');
  fs.writeFileSync(texPath, 'preserve this input');
  assert.throws(() => compileTex({ texPath, bin: path.join(dir, 'missing') }), {
    message: 'texPath must end in .tex',
  });
  assert.equal(fs.readFileSync(texPath, 'utf-8'), 'preserve this input');
});

test('compiles a relative texPath to an adjacent PDF', { skip, timeout: 300000 }, async () => {
  const dir = tmpDir();
  const texPath = path.join(dir, 'resume.tex');
  fs.writeFileSync(texPath, renderTex(template(), buildDocument(loadMaster(), identityTailored(loadMaster()))));
  const relativePath = path.relative(process.cwd(), texPath);
  assert.equal(path.isAbsolute(relativePath), false);
  const r = await compileTex({ texPath: relativePath });
  assert.equal(r.ok, true, r.log);
  assert.equal(r.pdfPath, path.join(dir, 'resume.pdf'));
  assert.equal(fs.readFileSync(r.pdfPath).subarray(0, 5).toString(), '%PDF-');
});

test('compiles the rendered fixture to a PDF', { skip, timeout: 300000 }, async () => {
  const dir = tmpDir();
  const texPath = path.join(dir, 'resume.tex');
  fs.writeFileSync(texPath, renderTex(template(), buildDocument(loadMaster(), identityTailored(loadMaster()))));
  const r = await compileTex({ texPath });
  assert.equal(r.ok, true, r.log);
  assert.equal(r.pdfPath, path.join(dir, 'resume.pdf'));
  assert.equal(fs.readFileSync(r.pdfPath).subarray(0, 5).toString(), '%PDF-');
});

test('LaTeX specials, unicode, and a pdfTeX-only template still compile', { skip, timeout: 300000 }, async () => {
  const master = loadMaster();
  master.contact.name = 'Zoë O’Neil-García';
  const t = identityTailored(master);
  t.summary = 'Ships C++ & C# services — 100% on-call, R&D_team #1, ~5 regions, 2^10 keys, {braces}, back\\slash, “quotes”, <tags>.';
  t.experience[0].roles[0].bullets[0].text = 'Cut costs by 35% at $500M+ scale with x_y & z -- fast.';
  const tpl = template().replace('\\begin{document}', '\\input{glyphtounicode}\n\\pdfgentounicode=1\n\\begin{document}');
  const dir = tmpDir();
  const texPath = path.join(dir, 'resume.tex');
  fs.writeFileSync(texPath, renderTex(tpl, buildDocument(master, t)));
  const r = await compileTex({ texPath });
  assert.equal(r.ok, true, r.log);
});

test('a broken document reports failure with the log tail and no PDF', { skip, timeout: 300000 }, async () => {
  const dir = tmpDir();
  const texPath = path.join(dir, 'bad.tex');
  fs.writeFileSync(path.join(dir, 'bad.pdf'), 'stale');
  fs.writeFileSync(texPath, '\\documentclass{article}\n\\begin{document}\n\\undefinedmacro\n\\end{document}\n');
  const r = await compileTex({ texPath });
  assert.equal(r.ok, false);
  assert.equal(r.pdfPath, null);
  assert.equal(fs.existsSync(path.join(dir, 'bad.pdf')), false, 'stale PDF removed');
  assert.match(r.log, /undefinedmacro|Undefined control sequence/);
});
