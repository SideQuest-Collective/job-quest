// app/tests/interview-render.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER_MD } = require('../lib/interview/contract');
const { writeOwned, isOwned, siblingPath } = require('../lib/interview/markers');
const render = require('../lib/interview/render-context');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jq-iv-render-')); }
const MD = `${MARKER_MD}\n# Generated\n`;
const JSONDOC = `${JSON.stringify({ _generatedBy: 'job-quest', cards: [] })}\n`;

const MASTER = {
  version: 1,
  contact: { name: 'Sam Rivera', email: 'sam@example.test', phone: '', linkedin: '', location: 'New York, NY', links: [] },
  headline: 'Senior Software Engineer', summary: 'Builds data platforms that teams rely on.',
  experience: [{ id: 'ex', employer: 'Example Corp', start: '2019-03', end: null, roles: [
    { id: 'sr', title: 'Senior Software Engineer', team: 'Data', start: '2022-01', end: null,
      bullets: [{ id: 'exp.sr.1', text: 'Cut batch latency from 15s to 3s.' }] }] }],
  projects: [{ id: 'proj.pantry', name: 'Pantry', tech: ['TypeScript'], bullets: [{ id: 'proj.pantry.1', text: 'Built a recipe planner.' }] }],
  skills: [{ group: 'Languages', items: ['Python', 'TypeScript'] }],
  education: [{ school: 'State University', degree: 'BS Computer Science', start: '2011', end: '2015' }],
  certifications: [],
};
const ROLE = { roleKey: 'Acme Capital|Software Engineer', company: 'Acme Capital', role: 'Software Engineer', level: 'Senior', location: 'New York, NY', url: 'https://jobs.example.com/acme/swe' };
const PROFILE = { locationPrefs: 'NYC (Hybrid)', targetLevel: 'Senior to Staff', timeline: 'actively searching', values: ['technical challenge', 'impact & mission'] };

test('siblingPath inserts .jq before the extension', () => {
  assert.equal(siblingPath('/x/cheatsheets/acme.json'), '/x/cheatsheets/acme.jq.json');
  assert.equal(siblingPath('/x/context/resume.md'), '/x/context/resume.jq.md');
});

test('an absent target is written', () => {
  const f = path.join(tmp(), 'context', 'resume.md');
  assert.deepEqual(writeOwned(f, MD), { written: f });
  assert.equal(fs.readFileSync(f, 'utf-8'), MD);
});

test('a marked markdown target is overwritten', () => {
  const f = path.join(tmp(), 'target.md');
  fs.writeFileSync(f, `${MARKER_MD}\nold\n`);
  assert.deepEqual(writeOwned(f, MD), { written: f });
  assert.equal(fs.readFileSync(f, 'utf-8'), MD);
});

test('an unmarked markdown target is never modified; the .jq sibling is written and reported', () => {
  const f = path.join(tmp(), 'target.md');
  fs.writeFileSync(f, '# My own notes\n');
  const r = writeOwned(f, MD);
  assert.deepEqual(r, { skipped: { path: f, reason: 'user-owned', wroteInstead: siblingPath(f) } });
  assert.equal(fs.readFileSync(f, 'utf-8'), '# My own notes\n');
  assert.equal(fs.readFileSync(siblingPath(f), 'utf-8'), MD);
  const again = writeOwned(f, `${MARKER_MD}\n# Newer\n`);
  assert.ok(again.skipped);
  assert.match(fs.readFileSync(siblingPath(f), 'utf-8'), /Newer/);
});

test('JSON ownership uses _generatedBy; a list-form user cheat sheet is not owned', () => {
  const dir = tmp();
  const mine = path.join(dir, 'mine.json');
  const theirs = path.join(dir, 'theirs.json');
  fs.writeFileSync(mine, JSONDOC);
  fs.writeFileSync(theirs, JSON.stringify([{ title: 'Hand made', category: 'intro', bullets: [] }]));
  assert.equal(isOwned(mine), true);
  assert.equal(isOwned(theirs), false);
  assert.ok(writeOwned(theirs, JSONDOC).skipped);
  assert.match(fs.readFileSync(theirs, 'utf-8'), /Hand made/);
});

test('writeOwned refuses content that does not carry the marker', () => {
  const dir = tmp();
  assert.throws(() => writeOwned(path.join(dir, 'a.md'), '# no marker\n'), /unmarked/);
  assert.throws(() => writeOwned(path.join(dir, 'a.json'), '[]'), /unmarked/);
});

test('writeOwned preserves a user-owned .jq sibling when both paths are occupied', () => {
  for (const [name, original, content] of [
    ['target.md', '# My own notes\n', MD],
    ['cards.json', JSON.stringify([{ title: 'Hand made' }]), JSONDOC],
  ]) {
    const dir = tmp();
    const file = path.join(dir, name);
    const sibling = siblingPath(file);
    try {
      fs.writeFileSync(file, original);
      fs.writeFileSync(sibling, original);
      const before = fs.readFileSync(file);
      const siblingBefore = fs.readFileSync(sibling);
      assert.deepEqual(writeOwned(file, content), {
        skipped: { path: file, reason: 'user-owned', wroteInstead: null, siblingUserOwned: true },
      });
      assert.deepEqual(fs.readFileSync(file), before);
      assert.deepEqual(fs.readFileSync(sibling), siblingBefore);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('atomic writes use distinct temporary paths even within the same millisecond', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'target.md');
  const legacyTemp = `${file}.tmp`;
  fs.writeFileSync(legacyTemp, 'user scratch data');
  t.mock.method(Date, 'now', () => 123456789);
  const rename = fs.renameSync;
  const sources = [];
  t.mock.method(fs, 'renameSync', (source, target) => {
    sources.push(source);
    assert.equal(target, file);
    rename(source, target);
  });
  writeOwned(file, MD);
  writeOwned(file, MD);
  assert.equal(new Set(sources).size, 2);
  for (const source of sources) {
    assert.ok(source.startsWith(`${file}.${process.pid}.123456789.`));
    assert.match(source.slice(`${file}.${process.pid}.123456789.`.length), /^[^.]+\.tmp$/);
    assert.equal(fs.existsSync(source), false);
  }
  assert.equal(fs.readFileSync(legacyTemp, 'utf-8'), 'user scratch data');
  assert.equal(fs.readFileSync(file, 'utf-8'), MD);
});

for (const failure of ['write', 'rename']) {
  test(`atomic writes remove temporary files after a ${failure} failure`, (t) => {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'target.md');
    const original = `${MARKER_MD}\noriginal\n`;
    fs.writeFileSync(file, original);
    const error = Object.assign(new Error(`simulated ${failure} failure`), { code: 'EIO' });
    if (failure === 'write') {
      const write = fs.writeFileSync;
      t.mock.method(fs, 'writeFileSync', (target) => {
        write(target, 'partial data');
        throw error;
      });
    } else {
      t.mock.method(fs, 'renameSync', () => { throw error; });
    }
    assert.throws(() => writeOwned(file, MD), (actual) => actual === error);
    assert.equal(fs.readFileSync(file, 'utf-8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['target.md']);
  });
}

test('an existing directory is user-owned and writes go to its sibling', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'target.md');
  fs.mkdirSync(file);
  assert.equal(isOwned(file), false);
  assert.deepEqual(writeOwned(file, MD), {
    skipped: { path: file, reason: 'user-owned', wroteInstead: siblingPath(file) },
  });
  assert.ok(fs.statSync(file).isDirectory());
  assert.equal(fs.readFileSync(siblingPath(file), 'utf-8'), MD);
  assert.equal(isOwned(path.join(dir, 'absent.md')), true);
});

test('an existing unreadable file is treated as user-owned', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'target.md');
  fs.writeFileSync(file, MD);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return read(target, ...args);
  });
  assert.equal(isOwned(file), false);
  assert.deepEqual(writeOwned(file, MD), {
    skipped: { path: file, reason: 'user-owned', wroteInstead: siblingPath(file) },
  });
  assert.equal(read(file, 'utf-8'), MD);
  assert.equal(read(siblingPath(file), 'utf-8'), MD);
});

test('Markdown ownership requires an exact first-line marker and accepts CRLF', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'target.md');
  const original = `${MARKER_MD}extra\nuser notes\n`;
  fs.writeFileSync(file, original);
  assert.equal(isOwned(file), false);
  assert.deepEqual(writeOwned(file, MD), {
    skipped: { path: file, reason: 'user-owned', wroteInstead: siblingPath(file) },
  });
  assert.equal(fs.readFileSync(file, 'utf-8'), original);
  assert.throws(() => writeOwned(file, original), /unmarked/);
  fs.writeFileSync(file, `${MARKER_MD}\r\nowned notes\r\n`);
  assert.equal(isOwned(file), true);
});

test('renderResumeMd wraps the P2 markdown with the marker', () => {
  const md = render.renderResumeMd(MASTER);
  assert.ok(md.startsWith(`${MARKER_MD}\n`));
  assert.ok(md.includes('Builds data platforms that teams rely on.'));
  assert.ok(md.includes('Cut batch latency from 15s to 3s.'));
  assert.ok(md.includes('Pantry'));
  assert.ok(md.includes('Built a recipe planner.'));
  assert.ok(md.endsWith('\n'));
});

test('renderJdMd carries level, location, posting, and the JD text', () => {
  const md = render.renderJdMd({ ...ROLE, jdText: '  Build trading tools.\n' });
  assert.equal(md, `${MARKER_MD}\n# Acme Capital: Software Engineer (job description)\n\nLevel: Senior. Location: New York, NY.\nPosting: https://jobs.example.com/acme/swe\n\nBuild trading tools.\n`);
});

test('renderTargetMd uses profile fields, the comp fallback, and tracker notes', () => {
  const md = render.renderTargetMd({ role: ROLE, profile: PROFILE, trackerEntry: { stage: 'phone-screen', notes: '[interview:2026-09-14_1030] Recruiter call 2026-09-14\nFacts they said:\n- Flat org\n[/interview:2026-09-14_1030]' } });
  assert.ok(md.startsWith(`${MARKER_MD}\n# Target: Acme Capital — Software Engineer\n`));
  assert.ok(md.includes('- Title and level I am targeting: Software Engineer (Senior)'));
  assert.ok(md.includes('- Compensation expectation: decide a number before the call'));
  assert.ok(md.includes('- Location and remote preference: NYC (Hybrid)'));
  assert.ok(md.includes('- Timeline: actively searching'));
  assert.ok(md.includes('- What I care about in the next role: technical challenge, impact & mission'));
  assert.ok(md.includes('- Flat org'));
});

test('renderTargetMd uses profile.comp when set and omits unknown lines', () => {
  const md = render.renderTargetMd({ role: { ...ROLE, location: null, url: null, level: null }, profile: { comp: { base: '200k', total: '300k' } }, trackerEntry: null });
  assert.ok(md.includes('- Compensation expectation: base: 200k; total: 300k'));
  assert.ok(!md.includes('Location of the role'));
  assert.ok(!md.includes('Timeline:'));
  assert.ok(!md.includes('## Notes from Job Quest'));
  assert.equal(render.formatComp('$180k-$210k'), '$180k-$210k');
  assert.equal(render.formatComp(''), null);
});
