// app/tests/workbook-import.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../lib/workbook/store');
const { importKit } = require('../lib/workbook/import');
const { writeKit } = require('./helpers/workbook-fixture');

const HAS_PY = !spawnSync('python3', ['--version']).error;
const SCRIPT = path.resolve(__dirname, '..', '..', 'skill', 'bin', 'import-workbook.sh');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-import-'));
const NO_TESTS = ['@@chapter id=extra company=both topic="Extra" title="Extra"', '## In plain English', '', 'x', '',
  '@@q id=extra-1 company=both topic="Extra" type=code diff=1 chapter=extra', 'Write f.', '@@rubric', '- r', '@@answer',
  '```python', 'def f():', '    return 1', '```', ''].join('\n');

test('importKit copies content, lints without blocking, and marks untested code unverified', async () => {
  const src = tmp();
  writeKit(src, { '30-extra.md': NO_TESTS, 'notes.txt': 'not content' });
  fs.mkdirSync(path.join(src, 'content.bak'));
  const dataDir = tmp();
  const r = await importKit({ dataDir, srcDir: src, roleKeys: ['Acme|Staff Engineer', 'Beta|SWE'], title: 'Acme + Beta kit' });
  assert.deepEqual([r.id, r.title, r.chapters, r.questions, r.glossary], ['acme-staff-engineer', 'Acme + Beta kit', 3, 4, 4]);
  assert.deepEqual(r.types, { mcq: 1, open: 1, code: 2 });
  assert.ok(r.lint.errors >= 1);
  assert.equal(r.lint.warnings, 1);
  assert.ok(r.lint.findings.some((f) => f.rule === 'chapter-sections' && f.file === '30-extra.md'));
  assert.deepEqual(r.verify, HAS_PY ? { passed: 1, failed: 0, unverified: 1 } : { passed: 0, failed: 0, unverified: 2 });
  const meta = store.readMeta(dataDir, r.id);
  assert.deepEqual([meta.source, meta.trigger, meta.status, meta.tier], ['imported', 'import', 'ready', 'onsite']);
  assert.deepEqual(meta.roleKeys, ['Acme|Staff Engineer', 'Beta|SWE']);
  assert.deepEqual(meta.companyNames, { acme: 'Acme', beta: 'Beta' });
  assert.deepEqual(fs.readdirSync(path.join(store.wbDir(dataDir, r.id), 'content')).sort(), ['10-intro.md', '20-algo.md', '30-extra.md', 'glossary-10-intro.txt', 'glossary-20-algo.txt']);
  assert.equal(store.readJsonFile(path.join(store.wbDir(dataDir, r.id), 'glossary.json'), []).length, 4);
  await assert.rejects(importKit({ dataDir, srcDir: src, roleKeys: ['Beta|SWE'] }), /already covers Beta\|SWE/);
  await assert.rejects(importKit({ dataDir, srcDir: tmp(), roleKeys: ['Gamma|Eng'] }), /has no content\/ directory/);
  await assert.rejects(importKit({ dataDir, srcDir: src, roleKeys: ['nopipe'] }), /Company\|Role/);
});

test('import-workbook.sh prints a JSON report and fails cleanly', () => {
  const src = tmp();
  writeKit(src);
  const dataDir = tmp();
  const ok = spawnSync('bash', [SCRIPT, src, '--roles', 'Acme|Eng', '--tier', 'screen'], { encoding: 'utf-8', env: { ...process.env, DATA_DIR: dataDir } });
  assert.equal(ok.status, 0, ok.stderr);
  const report = JSON.parse(ok.stdout);
  assert.deepEqual([report.id, report.chapters, report.questions], ['acme-eng', 2, 3]);
  assert.equal(store.readMeta(dataDir, 'acme-eng').tier, 'screen');
  const bad = spawnSync('bash', [SCRIPT, src], { encoding: 'utf-8', env: { ...process.env, DATA_DIR: tmp() } });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /--roles/);
});

test('install and skill docs know about workbooks', () => {
  const root = path.resolve(__dirname, '..', '..');
  const install = fs.readFileSync(path.join(root, 'install.sh'), 'utf-8');
  assert.match(install, /resume-files logs workbooks/);
  assert.match(install, /import-workbook\.sh" "\$BIN_DIR\/import-workbook\.sh"/);
  const skill = fs.readFileSync(path.join(root, 'skill', 'SKILL.md'), 'utf-8');
  assert.match(skill, /^## Workbooks$/m);
  assert.match(skill, /^### import-workbook\.sh$/m);
  assert.doesNotMatch(skill, /generate a tailored prep plan/);
});

test('importKit rejects role keys with an empty company or role before creating a workbook', async () => {
  const src = tmp();
  writeKit(src);
  const dataDir = tmp();
  for (const roleKey of ['|Engineer', 'Acme|', '  |Engineer', 'Acme|  ']) {
    await assert.rejects(importKit({ dataDir, srcDir: src, roleKeys: [roleKey] }), /Company\|Role/);
  }
  assert.deepEqual(store.listWorkbooks(dataDir), []);
});

test('importKit reports invalid chapter ids without blocking code verification', async () => {
  const src = tmp();
  writeKit(src, { '30-extra.md': NO_TESTS.replaceAll('extra', '__proto__') });
  const dataDir = tmp();
  const r = await importKit({ dataDir, srcDir: src, roleKeys: ['Acme|Engineer'] });
  assert.ok(r.lint.findings.some((f) => f.rule === 'bad-id'));
  assert.equal(store.readMeta(dataDir, r.id).status, 'ready');
  const verify = store.readJsonFile(path.join(r.dir, 'verify.json'), null);
  assert.equal(verify.chapters.__proto__[0].unverified, true);
});

test('fix round 1: failed copy removes a newly created workbook', async (t) => {
  const src = tmp(), dataDir = tmp();
  writeKit(src);
  const copy = fs.copyFileSync;
  let calls = 0;
  t.mock.method(fs, 'copyFileSync', (...args) => { if (++calls === 2) throw new Error('copy failed'); return copy(...args); });
  await assert.rejects(importKit({ dataDir, srcDir: src, roleKeys: ['Acme|Eng'] }), /copy failed/);
  assert.deepEqual(store.listWorkbooks(dataDir), []);
  assert.equal(fs.existsSync(store.wbDir(dataDir, 'acme-eng')), false);
});

test('fix round 1: import reuses interview workbook and preserves asked content and progress', async () => {
  const src = tmp(), dataDir = tmp();
  writeKit(src, { '99-asked-in-interviews.md': 'must not overwrite' });
  const m = store.createMinimal(dataDir, { roleKey: 'Acme|Eng' });
  store.appendChapterQuestions(dataDir, m.id, { questions: [] });
  store.writeProgress(dataDir, m.id, { answers: { interview: 'my answer' } });
  const asked = fs.readFileSync(path.join(store.wbDir(dataDir, m.id), 'content', store.ASKED.file), 'utf8');
  const report = await importKit({ dataDir, srcDir: src, roleKeys: ['Acme|Eng', 'Beta|SWE'] });
  assert.equal(report.id, m.id);
  assert.equal(store.listWorkbooks(dataDir).length, 1);
  assert.equal(store.readMeta(dataDir, m.id).source, 'imported');
  assert.equal(store.readMeta(dataDir, m.id).companyNames.beta, 'Beta');
  assert.equal(fs.readFileSync(path.join(report.dir, 'content', store.ASKED.file), 'utf8'), asked);
  assert.equal(store.readProgress(dataDir, m.id).answers.interview, 'my answer');
});

test('failed import into an interview workbook restores its content and metadata', async (t) => {
  const src = tmp(), dataDir = tmp();
  writeKit(src);
  // Exercise rollback when the append updates metadata in a later millisecond.
  const m = store.createMinimal(dataDir, { roleKey: 'Acme|Eng' }, () => new Date('2026-10-06T00:00:00.000Z'));
  store.appendChapterQuestions(dataDir, m.id, { questions: [] }, () => new Date('2026-10-06T00:00:00.001Z'));
  const beforeMeta = store.readMeta(dataDir, m.id);
  const dir = store.wbDir(dataDir, m.id);
  const before = fs.readFileSync(path.join(dir, 'content', store.ASKED.file), 'utf8');
  const copy = fs.copyFileSync;
  let calls = 0;
  t.mock.method(fs, 'copyFileSync', (...args) => { if (++calls === 2) throw new Error('copy failed'); return copy(...args); });
  await assert.rejects(importKit({ dataDir, srcDir: src, roleKeys: ['Acme|Eng'] }), /copy failed/);
  assert.deepEqual(store.readMeta(dataDir, m.id), beforeMeta);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'content')), [store.ASKED.file]);
  assert.equal(fs.readFileSync(path.join(dir, 'content', store.ASKED.file), 'utf8'), before);
});
