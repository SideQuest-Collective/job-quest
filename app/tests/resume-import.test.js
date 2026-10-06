// app/tests/resume-import.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { diffOps, lineDiff, wordDiff } = require('../lib/resume/diff');
const { importPySource, parseTexHeader, parseBuildPy, splitTopLevel } = require('../lib/resume/import-pysource');
const { validateMaster } = require('../lib/resume/master');
const { fixturePath, tmpDir } = require('./helpers/resume-fixtures');

const read = (...p) => fs.readFileSync(fixturePath('import', ...p), 'utf-8');
const inputs = () => ({ contentSrc: read('content.py'), buildSrc: read('build.py'), texSrc: read('resume_cv.tex'), educationSrc: read('cv-sections', 'education.tex'), summarySrc: read('cv-sections', 'summary.tex'), skillsSrc: read('cv-sections', 'skills.tex') });
const CLI = path.resolve(__dirname, '..', '..', 'skill', 'bin', 'import-resume.js');

test('lineDiff marks changes and collapses long unchanged runs', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nB\nc'), '  a\n- b\n+ B\n  c');
  assert.equal(lineDiff('same', 'same'), '(no changes)');
  const ten = Array.from({ length: 10 }, (_, i) => String(i + 1));
  assert.equal(lineDiff([...ten, 'x'].join('\n'), [...ten, 'y'].join('\n')), '  … 7 unchanged lines\n  8\n  9\n  10\n- x\n+ y');
});

test('wordDiff merges runs', () => {
  assert.deepEqual(wordDiff('Cut latency by 50%', 'Reduced latency by 50%'), [
    { op: 'del', text: 'Cut' }, { op: 'add', text: 'Reduced' }, { op: 'eq', text: 'latency by 50%' },
  ]);
  assert.deepEqual(diffOps([], ['a']), [{ op: 'add', text: 'a' }]);
});

test('splitTopLevel keeps parenthesized lists together', () => {
  assert.deepEqual(splitTopLevel('AWS (Lambda, S3, SQS), Docker, CI/CD'), ['AWS (Lambda, S3, SQS)', 'Docker', 'CI/CD']);
});

test('header, build.py and education parsing', () => {
  assert.deepEqual(parseTexHeader(read('resume_cv.tex')).contact, {
    name: 'Alex Example', email: 'alex@example.com', phone: '(+1) 555-010-0199',
    linkedin: 'linkedin.com/in/alex-example', location: 'Springfield, IL, USA', links: ['github.com/alex-example'],
  });
  const b = parseBuildPy(read('build.py'));
  assert.deepEqual(b.employer, { name: 'Globex Corp', start: '2018-06', end: null });
  assert.deepEqual(b.roles.map((r) => [r.key, r.title, r.team, r.start, r.end]), [
    ['sr', 'Senior Software Engineer', 'Billing Platform', '2023-02', null],
    ['ii', 'Software Engineer II', 'Billing Platform', '2021-01', '2023-02'],
    ['i', 'Software Engineer I', 'Internal Tools & Reporting', '2018-06', '2021-01'],
  ]);
});

test('importPySource maps the fixture to the expected master exactly', () => {
  const master = importPySource(inputs());
  assert.deepEqual(master, JSON.parse(read('expected-master.json')));
  assert.equal(validateMaster(master).ok, true);
});

test('Python source importer discovers arbitrary project tuples and derives IDs from display names', () => {
  const source = inputs();
  source.contentSrc += '\nFIRST_PROJECT = ("Weather Station", "Python, SQLite", ["Recorded local weather observations."])\nSECOND_PROJECT = ("Garden Notes", "TypeScript", ["Built a planting calendar."])\nNOT_A_PROJECT = ("Notes", "plain text", "not a bullet list")\n';
  const projects = importPySource(source).projects;
  assert.deepEqual(projects.slice(-2), [
    { id: 'proj.weather-station', name: 'Weather Station', tech: ['Python', 'SQLite'], bullets: [{ id: 'proj.weather-station.1', text: 'Recorded local weather observations.' }] },
    { id: 'proj.garden-notes', name: 'Garden Notes', tech: ['TypeScript'], bullets: [{ id: 'proj.garden-notes.1', text: 'Built a planting calendar.' }] },
  ]);
  assert.equal(projects.length, 4);
});

test('resume source fixture uses synthetic project names and IDs', () => {
  assert.deepEqual(importPySource(inputs()).projects.map(({ id, name }) => ({ id, name })), [
    { id: 'proj.pantry', name: 'Pantry' },
    { id: 'proj.relay', name: 'Relay' },
  ]);
});

test('importPySource honors --variant and reports bad input clearly', () => {
  assert.equal(importPySource({ ...inputs(), variant: 'Other' }).headline, 'Platform Engineer | AWS');
  assert.throws(() => importPySource({ ...inputs(), variant: 'Nope' }), /variant "Nope" not found in V \(have: Base, Other\)/);
  assert.throws(() => importPySource({ ...inputs(), buildSrc: 'x = 1\n' }), /employer line/);
});

test('CLI prints a diff and writes nothing without --write; --write saves; a re-run shows no changes', () => {
  const dataDir = tmpDir();
  const args = [CLI, '--content', fixturePath('import', 'content.py'), '--tex', fixturePath('import', 'resume_cv.tex'), '--data-dir', dataDir];
  const dry = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes('+   "headline": "Senior Software Engineer | Backend & Data",'), dry.stdout);
  assert.match(dry.stdout, /Dry run/);
  assert.equal(fs.existsSync(path.join(dataDir, 'resume', 'master.json')), false);
  const wet = spawnSync(process.execPath, [...args, '--write'], { encoding: 'utf-8' });
  assert.equal(wet.status, 0, wet.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'resume', 'master.json'), 'utf-8')), JSON.parse(read('expected-master.json')));
  const again = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  assert.match(again.stdout, /\(no changes\)/);
});

test('CLI without required flags prints usage and exits 2', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf-8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: import-resume/);
});

test('importPySource rejects unrelated executable assignments with a line number', () => {
  const source = inputs();
  source.contentSrc += '\nUNRELATED = forbidden_call()\n';
  assert.throws(() => importPySource(source), /line \d+/);
});

test('importPySource resolves cross-referenced top-level literals in V', () => {
  const source = inputs();
  source.contentSrc += '\nEXTRA = ("Example", "JavaScript", ["Example bullet."])\nV["Extra"] = dict(V["Base"])\nV["Extra"]["projects"] = [EXTRA]\nV["Extra"]["head"] = V["Extra"]["projects"][0][0]\n';
  assert.equal(importPySource({ ...source, variant: 'Extra' }).headline, 'Example');
  const expected = JSON.parse(read('expected-master.json'));
  expected.projects.push({ id: 'proj.example', name: 'Example', tech: ['JavaScript'], bullets: [{ id: 'proj.example.1', text: 'Example bullet.' }] });
  expected.meta.nextIds['proj.example'] = 2;
  assert.deepEqual(importPySource(source), expected);
});

test('importPySource defaults to base TeX sections and header instead of the first variant', () => {
  const source = inputs();
  source.contentSrc += '\nV["Base"]["head"] = "Company-specific headline"\n';
  const master = importPySource(source);
  assert.equal(master.headline, 'Senior Software Engineer | Backend & Data');
  assert.equal(master.summary, 'Software engineer building reliable services & tools. Improved throughput by 25% and saved $10K.');
  assert.deepEqual(master.skills, [
    { group: 'Languages', items: ['Python', 'TypeScript', 'SQL'] },
    { group: 'AWS & Infrastructure', items: ['AWS (Lambda, S3, SQS)', 'Docker', 'CI/CD'] },
  ]);
});

test('CLI announces base or explicit variant before the diff and imports the selected sections', (t) => {
  const dataDir = tmpDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const args = [CLI, '--content', fixturePath('import', 'content.py'), '--tex', fixturePath('import', 'resume_cv.tex'), '--data-dir', dataDir, '--write'];
  const base = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  assert.equal(base.status, 0, base.stderr);
  assert.equal(base.stdout.split('\n')[0], `Using base resume sections from ${fixturePath('import')}`);
  const file = path.join(dataDir, 'resume', 'master.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), JSON.parse(read('expected-master.json')));
  const variant = spawnSync(process.execPath, [...args, '--variant', 'Other'], { encoding: 'utf-8' });
  assert.equal(variant.status, 0, variant.stderr);
  assert.equal(variant.stdout.split('\n')[0], 'Using variant "Other" (of 2 variants)');
  const master = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(master.headline, 'Platform Engineer | AWS');
  assert.equal(master.summary, 'Backend engineer with 6+ years building data services on AWS.');
  assert.deepEqual(master.skills, [
    { group: 'Languages', items: ['Python', 'TypeScript', 'SQL'] },
    { group: 'Cloud', items: ['AWS (Lambda, S3, SQS)', 'Docker'] },
    { group: 'Practices', items: ['CI/CD', 'Code Review'] },
  ]);
});

for (const missing of ['summary', 'skills', 'both']) {
  test(`CLI reports first-variant fallback when ${missing} base sections are missing`, (t) => {
    const root = tmpDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'cv-sections'));
    fs.writeFileSync(path.join(root, 'resume.tex'), read('resume_cv.tex'));
    for (const section of ['summary', 'skills']) {
      if (missing !== section && missing !== 'both') fs.writeFileSync(path.join(root, 'cv-sections', `${section}.tex`), read('cv-sections', `${section}.tex`));
    }
    const dataDir = path.join(root, 'data');
    const result = spawnSync(process.execPath, [CLI, '--content', fixturePath('import', 'content.py'), '--tex', path.join(root, 'resume.tex'), '--data-dir', dataDir, '--write'], { encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], `Using base resume sections from ${root}`);
    const master = JSON.parse(fs.readFileSync(path.join(dataDir, 'resume', 'master.json'), 'utf-8'));
    const fallback = importPySource({ ...inputs(), variant: 'Base' });
    const base = JSON.parse(read('expected-master.json'));
    for (const section of ['summary', 'skills']) {
      const absent = missing === section || missing === 'both';
      assert.deepEqual(master[section], (absent ? fallback : base)[section]);
      if (absent) assert.match(result.stderr, new RegExp(`${section}\\.tex missing; falling back to first V entry "Base"`));
    }
    assert.equal(master.headline, parseTexHeader(read('resume_cv.tex')).headline);
  });
}

test('CLI rejects unknown flags with usage and exit 2', () => {
  const result = spawnSync(process.execPath, [CLI, '--content', fixturePath('import', 'content.py'), '--tex', fixturePath('import', 'resume_cv.tex'), '--varient', 'Other'], { encoding: 'utf-8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown flag: --varient/);
  assert.match(result.stderr, /Usage: import-resume/);
  assert.equal(result.stdout, '');
});

test('CLI rejects value flags without values, including before another flag', () => {
  for (const flag of ['--content', '--tex', '--build', '--variant', '--data-dir']) {
    for (const tail of [[], ['--write']]) {
      const result = spawnSync(process.execPath, [CLI, '--content', fixturePath('import', 'content.py'), '--tex', fixturePath('import', 'resume_cv.tex'), flag, ...tail], { encoding: 'utf-8' });
      assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
      assert.match(result.stderr, /Missing value for/);
      assert.match(result.stderr, /Usage: import-resume/);
      assert.equal(result.stdout, '');
    }
  }
});

test('CLI dry run creates no data directory and refuses a corrupt existing master', (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const args = [CLI, '--content', fixturePath('import', 'content.py'), '--tex', fixturePath('import', 'resume_cv.tex'), '--data-dir', dataDir];
  const dry = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(dataDir), false);
  const file = path.join(dataDir, 'resume', 'master.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  const wet = spawnSync(process.execPath, [...args, '--write'], { encoding: 'utf-8' });
  assert.equal(wet.status, 1);
  assert.match(wet.stderr, /import-resume:/);
  assert.equal(fs.readFileSync(file, 'utf-8'), '{broken');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
