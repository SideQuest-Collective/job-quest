const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DEFAULT_TEMPLATE, ensureTemplate } = require('../lib/resume/render');

const root = path.resolve(__dirname, '..', '..');

test('install.sh is valid bash and provisions the resume data directories', () => {
  const script = path.join(root, 'install.sh');
  execFileSync('bash', ['-n', script]);
  const src = fs.readFileSync(script, 'utf-8');
  assert.match(src, /DATA_DIRS=\([^)]*\bresume\b(?!-)[^)]*\)/);
  assert.ok(src.includes('mkdir -p "$DATA_DIR/resume/template" "$DATA_DIR/resume/tailored"'));
});

test('SKILL.md documents resume tailoring', () => {
  const skill = fs.readFileSync(path.join(root, 'skill', 'SKILL.md'), 'utf-8');
  assert.ok(skill.indexOf('## Resume Tailoring') > 0);
  assert.ok(skill.indexOf('## Resume Tailoring') < skill.indexOf('## Schedule Management'));
  assert.ok(skill.includes('import-resume.js --content'));
});

test('app dependency installation omits optional dependencies', () => {
  const src = fs.readFileSync(path.join(root, 'install.sh'), 'utf-8');
  assert.match(src, /cd "\$APP_DIR\/app" && npm install --silent --omit=optional/);
});

for (const scenario of ['no upload', 'valid upload', 'upload without macros', 'existing template']) {
  test(`installer leaves template provisioning to runtime and preserves existing files: ${scenario}`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-install-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const product = path.join(home, '.job-quest');
    const app = path.join(product, 'app');
    const data = path.join(product, 'data');
    const bin = path.join(home, 'test-bin');
    fs.mkdirSync(path.join(app, '.git'), { recursive: true });
    fs.mkdirSync(path.join(app, 'app'));
    fs.mkdirSync(bin);
    for (const dir of ['skill', 'lib']) {
      fs.cpSync(path.join(root, dir), path.join(app, dir), { recursive: true });
    }
    // Exercise the full installer without network, dependency lifecycle scripts,
    // or a platform-specific compiler. All installation writes stay in home.
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    for (const [command, body] of Object.entries({
      git: '[ "$*" = "pull" ]',
      npm: 'printf "%s\\n" "$*" > "$HOME/npm-args"',
      uname: 'echo Linux',
    })) {
      fs.writeFileSync(path.join(bin, command), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const template = path.join(data, 'resume/template/resume_cv.tex');
    const existing = '% customized template; preserve verbatim\n';
    if (scenario !== 'no upload') {
      fs.mkdirSync(path.join(data, 'resume-files'), { recursive: true });
      const uploaded = scenario === 'valid upload'
        ? fs.readFileSync(DEFAULT_TEMPLATE, 'utf8')
        : '\\documentclass{article}\n\\begin{document}\nUploaded resume\n\\end{document}\n';
      fs.writeFileSync(path.join(data, 'resume-files/resume_cv.tex'), uploaded);
    }
    if (scenario === 'existing template') {
      fs.mkdirSync(path.dirname(template), { recursive: true });
      fs.writeFileSync(template, existing);
    }
    const output = execFileSync('/bin/bash', [path.join(root, 'install.sh')], {
      cwd: home,
      env: {
        HOME: home,
        JOB_QUEST_HOME: product,
        JOB_QUEST_RUNTIME: 'codex',
        PATH: `${bin}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ok(fs.statSync(path.join(data, 'resume/template')).isDirectory());
    assert.ok(fs.statSync(path.join(data, 'resume/tailored')).isDirectory());
    if (scenario === 'existing template') {
      assert.equal(fs.readFileSync(template, 'utf8'), existing);
    } else {
      assert.equal(fs.existsSync(template), false, 'installer must leave template provisioning to ensureTemplate');
    }
    assert.equal(fs.readFileSync(path.join(home, 'npm-args'), 'utf8'), 'install --silent --omit=optional\n');
    assert.ok(output.includes('Note: tectonic not found. Resume tailoring needs it to build PDFs: brew install tectonic'));
  });
}

test('ensureTemplate provisions the bundled default when the uploaded resume lacks required macros', (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-template-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const uploaded = path.join(data, 'resume-files', 'resume_cv.tex');
  const source = '\\documentclass{article}\n\\begin{document}\nUploaded resume\n\\end{document}\n';
  fs.mkdirSync(path.dirname(uploaded), { recursive: true });
  fs.writeFileSync(uploaded, source);

  const target = ensureTemplate(data);

  assert.equal(target, path.join(data, 'resume', 'template', 'resume_cv.tex'));
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(DEFAULT_TEMPLATE, 'utf8'));
  assert.equal(fs.readFileSync(uploaded, 'utf8'), source);
});
