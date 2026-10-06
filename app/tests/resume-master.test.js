// app/tests/resume-master.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  emptyMaster, formatDate, formatRange, parseDisplayDate, validateMaster, assignIds,
  masterBulletIndex, allMasterText, renderMarkdown, readMaster, writeMaster,
} = require('../lib/resume/master');
const { loadMaster, tmpDir } = require('./helpers/resume-fixtures');

test('master saves keep separate payloads when writes interleave', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'resume', 'master.json');
  const first = { ...loadMaster(), headline: 'First resume' };
  const second = { ...loadMaster(), headline: 'Second resume' };
  const rename = fs.renameSync;
  const temps = [];
  t.mock.method(fs, 'renameSync', (temp, destination) => {
    temps.push(temp);
    if (temps.length === 1) {
      const savedSecond = writeMaster(dir, second);
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(savedSecond, null, 2));
    }
    rename(temp, destination);
  });
  const savedFirst = writeMaster(dir, first);
  assert.equal(new Set(temps).size, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(savedFirst, null, 2));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['master.json']);
});

for (const [input, error] of [
  [{ experience: [null] }, 'experience[0]: must be an object'],
  [{ experience: [{ roles: 'x' }] }, 'experience[0].roles: must be an array'],
  [{ experience: 1 }, 'experience: must be an array'],
  [{ experience: [{ roles: [null] }] }, 'experience[0].roles[0]: must be an object'],
  [{ experience: [{ roles: [{ bullets: 1 }] }] }, 'experience[0].roles[0].bullets: must be an array'],
  [{ projects: 1 }, 'projects: must be an array'],
  [{ projects: [null] }, 'projects[0]: must be an object'],
  [{ projects: [{ bullets: 1 }] }, 'projects[0].bullets: must be an array'],
]) {
  test(`writeMaster reports malformed collections: ${error}`, (t) => {
    const dir = tmpDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.throws(() => writeMaster(dir, input), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(Array.isArray(err.validation));
      assert.ok(err.validation.every((message) => typeof message === 'string'));
      assert.ok(err.validation.includes(error));
      return true;
    });
    assert.deepEqual(fs.readdirSync(dir), [], 'invalid input must not write any files');
  });
}

test('readMaster rejects corrupt JSON and writeMaster preserves it', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'resume', 'master.json');
  fs.mkdirSync(path.dirname(file));
  const corrupt = '{"version": 1,';
  fs.writeFileSync(file, corrupt);
  assert.throws(() => readMaster(dir), SyntaxError);
  assert.throws(() => writeMaster(dir, loadMaster()), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf-8'), corrupt);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['master.json']);
});

test('readMaster returns an empty master for a missing file', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readMaster(dir), emptyMaster());
});

test('assignIds ignores fractional nextIds counters', () => {
  const prev = loadMaster();
  prev.meta.nextIds['exp.sr'] = 6.5;
  const next = loadMaster();
  next.experience[0].roles[0].bullets.push({ text: 'New bullet.' });
  const out = assignIds(prev, next);
  assert.equal(out.experience[0].roles[0].bullets.at(-1).id, 'exp.sr.6');
  assert.equal(out.meta.nextIds['exp.sr'], 7);
});

test('date helpers', () => {
  assert.equal(formatDate('2025-01'), 'Jan 2025');
  assert.equal(formatDate(null), 'Present');
  assert.equal(formatDate('2016'), '2016');
  assert.equal(formatRange('2019-03', null), 'Mar 2019 – Present');
  assert.equal(formatRange('2019-03', '2022-05', ' -- '), 'Mar 2019 -- May 2022');
  assert.equal(parseDisplayDate('Mar 2019'), '2019-03');
  assert.equal(parseDisplayDate('Present'), null);
  assert.equal(parseDisplayDate('2016'), '2016');
  assert.throws(() => parseDisplayDate('Spring 2019'), /unrecognized date/);
});

test('the fixture master is valid and empty masters are valid', () => {
  assert.deepEqual(validateMaster(loadMaster()), { ok: true, errors: [] });
  assert.equal(validateMaster(emptyMaster()).ok, true);
});

test('validation reports bad dates, duplicate ids, empty text and dangling variants', () => {
  const m = loadMaster();
  m.experience[0].start = '2019/03';
  m.experience[0].roles[1].bullets[0].id = 'exp.sr.1';
  m.experience[0].roles[2].bullets[0].text = '  ';
  m.projects[0].bullets.push({ id: 'proj.pantry.2', text: 'Alt phrasing.', variantOf: 'proj.pantry.99' });
  const { ok, errors } = validateMaster(m);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.startsWith('experience[0].start:')), errors.join('\n'));
  assert.ok(errors.some((e) => /duplicate id exp\.sr\.1/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('experience[0].roles[2].bullets[0].text:')), errors.join('\n'));
  assert.ok(errors.some((e) => /variantOf .*proj\.pantry\.99/.test(e)), errors.join('\n'));
});

test('assignIds keeps existing ids, numbers new bullets, and never reuses a deleted id', () => {
  const prev = loadMaster();
  const next = JSON.parse(JSON.stringify(prev));
  next.experience[0].roles[0].bullets[0].text = 'Edited text keeps its id.';
  next.experience[0].roles[0].bullets.splice(4, 1); // delete exp.sr.5
  next.experience[0].roles[0].bullets.push({ text: 'Brand new bullet with 2 numbers 3.' });
  const a = assignIds(prev, next);
  assert.equal(a.experience[0].roles[0].bullets[0].id, 'exp.sr.1');
  assert.equal(a.experience[0].roles[0].bullets[4].id, 'exp.sr.6');
  assert.equal(a.meta.nextIds['exp.sr'], 7);
  const b = JSON.parse(JSON.stringify(a));
  b.experience[0].roles[0].bullets.pop(); // delete exp.sr.6
  b.experience[0].roles[0].bullets.push({ text: 'Another new bullet.' });
  assert.equal(assignIds(a, b).experience[0].roles[0].bullets[4].id, 'exp.sr.7');
});

test('assignIds replaces duplicate ids and numbers project bullets by project id', () => {
  const m = loadMaster();
  m.projects[1].bullets.push({ id: 'proj.relay.1', text: 'Duplicate id.' });
  const out = assignIds(null, m);
  assert.deepEqual(out.projects[1].bullets.map((b) => b.id), ['proj.relay.1', 'proj.relay.2', 'proj.relay.3']);
});

test('bullet index and all-master text', () => {
  const m = loadMaster();
  const idx = masterBulletIndex(m);
  assert.equal(idx.size, 16);
  assert.deepEqual({ ...idx.get('exp.ii.2'), text: undefined }, { id: 'exp.ii.2', text: undefined, kind: 'exp', employerId: 'globex', roleId: 'ii', label: 'Software Engineer II at Globex Corp' });
  assert.equal(idx.get('proj.relay.2').kind, 'proj');
  const text = allMasterText(m);
  assert.match(text, /Feb 2022 – Present/);
  assert.match(text, /Cloudflare Workers/);
  assert.ok(!text.includes('alex@example.com'), 'contact is not master evidence');
});

test('renderMarkdown renders contact, summary, dated roles, projects, skills, education', () => {
  const tiny = {
    version: 1,
    contact: { name: 'Sam Doe', email: 'sam@example.com', phone: '555-010-0100', linkedin: 'linkedin.com/in/sam', location: 'Austin, TX', links: [] },
    headline: 'Backend Engineer',
    summary: 'Builds APIs.',
    experience: [{ id: 'acme', employer: 'Acme', start: '2020-01', end: null, roles: [{ id: 'eng', title: 'Engineer', team: 'Core', start: '2020-01', end: null, bullets: [{ id: 'exp.eng.1', text: 'Built 3 APIs.' }, { id: 'exp.eng.2', text: 'Alt phrasing.', variantOf: 'exp.eng.1' }] }] }],
    projects: [{ id: 'proj.x', name: 'X', tech: ['Go'], bullets: [{ id: 'proj.x.1', text: 'Wrote X.' }] }],
    skills: [{ group: 'Languages', items: ['Go', 'SQL'] }],
    education: [{ school: 'State U', degree: 'BS CS', start: '', end: '2019-05' }],
    certifications: [],
    meta: { nextIds: {} },
  };
  assert.equal(renderMarkdown(tiny), [
    '# Sam Doe', '', 'sam@example.com | 555-010-0100 | linkedin.com/in/sam | Austin, TX', '', '**Backend Engineer**',
    '', '## Summary', '', 'Builds APIs.',
    '', '## Experience', '', '### Acme (Jan 2020 – Present)', '', '**Engineer**, Core (Jan 2020 – Present)', '', '- Built 3 APIs.',
    '', '## Projects', '', '### X (Go)', '', '- Wrote X.',
    '', '## Skills', '', '- **Languages:** Go, SQL',
    '', '## Education', '', '- State U, BS CS (May 2019)',
  ].join('\n') + '\n');
});

test('readMaster defaults to empty; writeMaster assigns ids, validates, and persists', () => {
  const dir = tmpDir();
  assert.deepEqual(readMaster(dir), emptyMaster());
  const m = loadMaster();
  m.experience[0].roles[2].bullets.push({ text: 'New bullet for 2 teams.' });
  const saved = writeMaster(dir, m);
  assert.equal(saved.experience[0].roles[2].bullets[4].id, 'exp.i.5');
  assert.deepEqual(readMaster(dir), saved);
  assert.ok(fs.existsSync(path.join(dir, 'resume', 'master.json')));
  const bad = loadMaster();
  bad.experience[0].roles[0].start = 'soon';
  assert.throws(() => writeMaster(dir, bad), (err) => Array.isArray(err.validation) && err.validation.length > 0);
});
