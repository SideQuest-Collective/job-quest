// app/tests/resume-render.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_TEMPLATE, toAscii, latexEscape, preambleOf, buildDocument, renderTex } = require('../lib/resume/render');
const { loadMaster, identityTailored } = require('./helpers/resume-fixtures');

const template = () => fs.readFileSync(DEFAULT_TEMPLATE, 'utf-8');

for (const withEmployer of [false, true]) {
  test(`renderTex omits Experience when ${withEmployer ? 'employers have no roles' : 'experience is empty'}`, () => {
    const master = loadMaster();
    master.experience = withEmployer ? master.experience.map((e) => ({ ...e, roles: [] })) : [];
    master.projects = [];
    master.certifications = [];
    const tex = renderTex(template(), buildDocument(master, identityTailored(master)));
    const body = tex.slice(tex.indexOf('\\begin{document}'));
    assert.ok(!body.includes('\\section{Experience}'));
    assert.ok(!body.includes('\\cventrystart'));
    assert.ok(!body.includes('\\cventryend'));
  });
}

test('renderTex with empty experience compiles with Tectonic', (t) => {
  const version = spawnSync('tectonic', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error?.code === 'ENOENT') {
    t.skip('Tectonic is not installed; skipping empty-experience compilation only');
    return;
  }
  assert.ifError(version.error);
  assert.equal(version.status, 0, version.stderr);
  const master = loadMaster();
  master.experience = [];
  const tex = renderTex(template(), buildDocument(master, identityTailored(master)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-empty-experience-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'resume.tex');
  fs.writeFileSync(source, tex);
  const result = spawnSync('tectonic', ['--outdir', dir, source], { encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.statSync(path.join(dir, 'resume.pdf')).size > 0);
});

test('toAscii preserves word boundaries at tabs and carriage returns', () => {
  assert.equal(toAscii('a\tb'), 'a b');
  assert.equal(toAscii('a\rb'), 'a b');
  assert.equal(toAscii('a\r\nb\tc'), 'a \nb c');
  assert.equal(latexEscape('R&D\ttools\rwork'), 'R\\&D tools work');
});

test('latexEscape escapes every special character', () => {
  assert.equal(latexEscape('\\ & % $ # _ { } ~ ^'), '\\textbackslash{} \\& \\% \\$ \\# \\_ \\{ \\} \\textasciitilde{} \\textasciicircum{}');
  assert.equal(latexEscape('a<b>c'), 'a\\textless{}b\\textgreater{}c');
});

test('typographic punctuation becomes ASCII before escaping', () => {
  assert.equal(toAscii('“Fast” — it’s 3–5x… café'), '"Fast" - it\'s 3-5x... cafe');
  assert.equal(latexEscape('R&D | C++ -- 100%'), 'R\\&D $|$ C++ -{}- 100\\%');
});

test('buildDocument copies employers, titles, teams and dates from master and sorts newest first', () => {
  const master = loadMaster();
  const t = identityTailored(master);
  t.experience[0].roles[0].title = 'CTO';
  const reversed = { ...master, experience: [{ ...master.experience[0], roles: master.experience[0].roles.slice().reverse() }] };
  const doc = buildDocument(reversed, t);
  assert.deepEqual(doc.experience[0].roles.map((r) => r.title), ['Senior Software Engineer', 'Software Engineer II', 'Software Engineer I']);
  assert.deepEqual(doc.experience[0].roles[0].bullets, master.experience[0].roles[0].bullets.map((b) => b.text));
  assert.equal(doc.contact.email, 'alex@example.com');
  assert.deepEqual(doc.education, master.education);
  assert.deepEqual(doc.projects.map((p) => p.name), ['Pantry (Recipe Planner App)', 'Relay (Chat to Email Bridge)']);
});

test('renderTex fills sections in order using the template macros', () => {
  const tex = renderTex(template(), buildDocument(loadMaster(), identityTailored(loadMaster())));
  const order = ['\\section{Summary}', '\\section{Experience}', '\\section{Projects}', '\\section{Skills}', '\\section{Education}'].map((s) => tex.indexOf(s));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), order.join(','));
  assert.match(tex, /\\textbf\{Globex Corp\} & \\small Jun 2017 -- Present/);
  assert.match(tex, /\\textbf\{Senior Software Engineer\} \\textit\{\\small -- Billing Platform\} & \\small Feb 2022 -- Present/);
  assert.match(tex, /\\cvskill\{Cloud\}\{AWS \(Lambda, S3, SQS, Step Functions\), Docker, Kubernetes, CloudWatch\}/);
  assert.match(tex, /\\href\{mailto:alex@example\.com\}\{alex@example\.com\}/);
  assert.match(tex, /\\href\{https:\/\/linkedin\.com\/in\/alex-example\}\{linkedin\.com\/in\/alex-example\}/);
  assert.match(tex, /Internal Tools \\& Reporting/);
  assert.match(tex, /\\item Cut P99 API latency from 900ms to 250ms/);
  assert.match(tex, /\\normalsize Senior Software Engineer \$\|\$ Backend Systems \\& Data Platforms/);
  assert.ok(tex.trimEnd().endsWith('\\end{document}'));
});

test('pdfTeX-only primitives are stripped; templates without the macros are rejected', () => {
  const tpl = template().replace('\\begin{document}', '\\input{glyphtounicode}\n\\pdfgentounicode=1\n\\pdfminorversion=7\n\\begin{document}');
  const pre = preambleOf(tpl);
  assert.ok(!/glyphtounicode|pdfgentounicode|pdfminorversion/.test(pre));
  assert.throws(() => renderTex('\\documentclass{article}\n\\begin{document}\n\\end{document}\n', { contact: {} }), /missing macro \\cventry/);
  assert.throws(() => renderTex('no document here', { contact: {} }), /no \\begin\{document\}/);
});

test('preambleOf ignores commented document markers and preserves the full preamble', () => {
  const source = template();
  const comment = '% everything before \\begin{document} is the preamble\n';
  const expected = source.slice(0, source.indexOf('\\begin{document}'));
  assert.equal(preambleOf(comment + source), comment + expected);
  assert.equal(preambleOf(source.replace('\\begin{document}', '  \\begin{document}')), expected + '  ');
  assert.throws(() => preambleOf(comment), /no \\begin\{document\}/);
});

test('preambleOf strips all pdfTeX primitives and requires each template macro and environment', () => {
  const primitives = '\\input{glyphtounicode}\n\\pdfgentounicode = 1\n\\pdfminorversion=7\n\\pdfcompresslevel=9\n\\pdfobjcompresslevel = 3\n';
  assert.equal(preambleOf(template().replace('\\begin{document}', primitives + '\\begin{document}')), preambleOf(template()));
  for (const name of ['cventry', 'cvskill', 'cventrystart', 'cventryend']) {
    const source = template().replace(`\\newcommand{\\${name}}`, `\\newcommand{\\other${name}}`);
    assert.throws(() => preambleOf(source), { message: `template is missing macro \\${name}` });
  }
  for (const name of ['cvitems', 'cvparagraph']) {
    const source = template().replace(`\\newenvironment{${name}}`, `\\newenvironment{other${name}}`);
    assert.throws(() => preambleOf(source), { message: `template is missing environment ${name}` });
  }
});

test('toAscii normalizes spacing, bullets, multiplication and accents and drops remaining Unicode', () => {
  assert.equal(toAscii('a\u00a0b\u2007c\u202fd • e · f × 2 naïve 😀\nnext'), 'a b c d - e - f x 2 naive \nnext');
  assert.equal(toAscii('a—b'), 'a - b');
  assert.equal(toAscii(null), '');
});

test('buildDocument preserves master facts with extra and duplicate tailored entries', () => {
  const master = loadMaster();
  master.certifications = [{ name: 'Cloud Certificate', date: '2024-01' }];
  master.experience.unshift({ id: 'older', employer: 'Earlier Employer', start: '2015-01', end: '2017-05', roles: [] });
  const t = identityTailored(master);
  t.contact = { name: 'Wrong', email: 'wrong@example.com' };
  t.education = [];
  t.certifications = [];
  const employer = t.experience[1];
  Object.assign(employer, { employer: 'Wrong Employer', start: '2099-01', end: '2099-02' });
  Object.assign(employer.roles[0], { title: 'CTO', team: 'Wrong Team', start: '2099-01', end: '2099-02' });
  employer.roles.push({ ...employer.roles[0] }, { id: 'unknown-role', title: 'Invented Role', bullets: [] });
  t.experience.push({ ...employer }, { id: 'unknown-employer', roles: [] });
  t.projects.push({ ...t.projects[0] }, { id: 'unknown-project', bullets: [] });
  t.projects[0].name = 'Wrong Project';
  const before = JSON.stringify({ master, t });
  const doc = buildDocument(master, t);
  assert.deepEqual(doc.contact, master.contact);
  assert.deepEqual(doc.education, master.education);
  assert.deepEqual(doc.certifications, master.certifications);
  assert.deepEqual(doc.experience.map((e) => e.employer), ['Globex Corp', 'Earlier Employer']);
  const original = master.experience[1];
  assert.equal(doc.experience[0].start, original.start);
  assert.equal(doc.experience[0].end, original.end);
  assert.deepEqual(doc.experience[0].roles, original.roles.map((r) => ({
    title: r.title, team: r.team, start: r.start, end: r.end, bullets: r.bullets.map((b) => b.text),
  })));
  assert.ok(doc.projects.every((p) => master.projects.some((mp) => mp.name === p.name)));
  assert.doesNotThrow(() => renderTex(template(), doc));
  assert.equal(JSON.stringify({ master, t }), before);
});

test('tailored content and project selection render while optional sections are omitted', () => {
  const master = loadMaster();
  const t = identityTailored(master);
  t.headline = 'Selected headline';
  t.summary = 'Selected summary';
  t.experience[0].roles[0].bullets = [{ src: 'exp.sr.2', text: 'Selected bullet' }];
  t.skills = [{ group: 'Selected', items: ['Python'] }];
  t.projects = [t.projects[1]];
  const doc = buildDocument(master, t);
  assert.equal(doc.headline, t.headline);
  assert.equal(doc.summary, t.summary);
  assert.deepEqual(doc.skills, t.skills);
  assert.deepEqual(doc.experience[0].roles[0].bullets, ['Selected bullet']);
  assert.deepEqual(doc.projects.map((p) => p.name), ['Relay (Chat to Email Bridge)']);
  assert.doesNotMatch(renderTex(template(), doc), /\\section\{Certifications\}/);
  t.projects = [];
  master.certifications = [{ name: 'Cloud & Systems', date: '2024-01' }];
  const tex = renderTex(template(), buildDocument(master, t));
  assert.doesNotMatch(tex, /\\section\{Projects\}/);
  assert.ok(tex.indexOf('\\section{Certifications}') > tex.indexOf('\\section{Education}'));
  assert.match(tex, /Cloud \\& Systems/);
});
