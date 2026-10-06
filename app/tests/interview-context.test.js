// app/tests/interview-context.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { roleIds, writeInterviewContext } = require('../lib/interview/context');
const { cheatsheetWorkDir } = require('../lib/interview/cheatsheet');
const { MARKER_MD } = require('../lib/interview/contract');
const { findTailored } = require('../lib/interview/resume-bridge');
const { makeEnv, seedRole, seedWorkbook, installFake, withFakeAgent, readJson, fakeCalls, ROLE_KEY, FAKE_CHEATSHEET } = require('./helpers/interview-env');

const ROLE_ID = 'acme-capital-software-engineer';
const MASTER = {
  version: 1,
  contact: { name: 'Sam Rivera', email: 'sam@example.test', phone: '', linkedin: '', location: 'New York, NY', links: [] },
  headline: 'Senior Software Engineer', summary: 'Builds data platforms that teams rely on.',
  experience: [{ id: 'ex', employer: 'Example Corp', start: '2019-03', end: null, roles: [
    { id: 'sr', title: 'Senior Software Engineer', team: 'Data', start: '2022-01', end: null, bullets: [{ id: 'exp.sr.1', text: 'Cut batch latency from 15s to 3s.' }] }] }],
  projects: [], skills: [{ group: 'Languages', items: ['Python'] }],
  education: [{ school: 'State University', degree: 'BS Computer Science', start: '2011', end: '2015' }], certifications: [],
};

function setup(t, { workbook = true, tailored = true, master = true } = {}) {
  withFakeAgent(t);
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  seedRole(env.dataDir);
  fs.writeFileSync(path.join(env.dataDir, 'profile.json'), JSON.stringify({ locationPrefs: 'NYC (Hybrid)', timeline: 'actively searching', values: ['technical challenge'] }));
  if (master) {
    fs.mkdirSync(path.join(env.dataDir, 'resume'), { recursive: true });
    fs.writeFileSync(path.join(env.dataDir, 'resume', 'master.json'), JSON.stringify(MASTER));
  }
  if (tailored) {
    const d = path.join(env.dataDir, 'resume', 'tailored', ROLE_ID);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: ROLE_ID, roleKeys: [ROLE_KEY], status: 'done' }));
    fs.writeFileSync(path.join(d, 'jd.txt'), 'Build trading tools in Python.');
  }
  if (workbook) {
    seedWorkbook(env.dataDir);
    installFake(cheatsheetWorkDir(env.dataDir, ROLE_ID), 'interview-cheatsheet', FAKE_CHEATSHEET);
  }
  const p = {
    ctx: (f) => path.join(env.interviewHome, 'context', f),
    cheatsheet: path.join(env.interviewHome, 'cheatsheets', 'acme-capital.json'),
    practice: path.join(env.interviewHome, 'practice', `${ROLE_ID}.json`),
  };
  return { ...env, p };
}

test('writes resume, JD, target, cheat sheet, and practice set for a role with a workbook', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
  assert.deepEqual(r.written.slice().sort(), [p.ctx('acme-capital-jd.md'), p.ctx('resume.md'), p.ctx('target.md'), p.cheatsheet, p.practice].sort());
  assert.deepEqual(r.skipped, []);
  assert.equal(r.cheatsheet, p.cheatsheet);
  assert.equal(r.practice, p.practice);
  const cs = readJson(p.cheatsheet);
  assert.equal(cs._generatedBy, 'job-quest');
  assert.equal(cs.contract, 'jq-interview/1');
  assert.equal(cs.roleKey, ROLE_KEY);
  assert.equal(cs.cards.length, 2);
  assert.deepEqual(readJson(p.practice).questions.map((q) => q.qid), ['c1']);
  assert.match(fs.readFileSync(p.ctx('acme-capital-jd.md'), 'utf-8'), /Build trading tools in Python\./);
  for (const f of ['resume.md', 'target.md', 'acme-capital-jd.md']) assert.ok(fs.readFileSync(p.ctx(f), 'utf-8').startsWith(MARKER_MD));
});

test('user-owned target and cheat sheet are left alone; .jq siblings are written and reported', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  fs.writeFileSync(p.ctx('target.md'), '# mine\n');
  fs.mkdirSync(path.dirname(p.cheatsheet), { recursive: true });
  fs.writeFileSync(p.cheatsheet, JSON.stringify([{ title: 'Hand made', category: 'intro', bullets: [] }]));
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'system' });
  assert.deepEqual(r.skipped, [
    { path: p.ctx('target.md'), reason: 'user-owned', wroteInstead: p.ctx('target.jq.md') },
    { path: p.cheatsheet, reason: 'user-owned', wroteInstead: path.join(interviewHome, 'cheatsheets', 'acme-capital.jq.json') },
  ]);
  assert.equal(fs.readFileSync(p.ctx('target.md'), 'utf-8'), '# mine\n');
  assert.match(fs.readFileSync(p.cheatsheet, 'utf-8'), /Hand made/);
  assert.equal(r.cheatsheet, p.cheatsheet);
  assert.deepEqual(readJson(r.practice).questions.map((q) => q.qid), ['s1']);
});

test('without a workbook or master: no agent runs; gaps are reported, the rest is written', async (t) => {
  const { dataDir, interviewHome, p } = setup(t, { workbook: false, master: false });
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
  assert.deepEqual(r.written.slice().sort(), [p.ctx('acme-capital-jd.md'), p.ctx('target.md')].sort());
  assert.deepEqual(r.skipped, [
    { path: p.ctx('resume.md'), reason: 'no-master-resume' },
    { path: p.cheatsheet, reason: 'no-workbook' },
    { path: p.practice, reason: 'no-workbook' },
  ]);
  assert.equal(r.cheatsheet, null);
  assert.equal(r.practice, null);
  assert.deepEqual(fakeCalls(cheatsheetWorkDir(dataDir, ROLE_ID)), {});
});

test('without a tailored JD the posting is fetched; a failed fetch is reported', async (t) => {
  const { dataDir, interviewHome, p } = setup(t, { tailored: false, workbook: false });
  const ok = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, fetchJd: async (url) => ({ ok: true, text: `Fetched from ${url}` }) });
  assert.ok(ok.written.includes(p.ctx('acme-capital-jd.md')));
  assert.match(fs.readFileSync(p.ctx('acme-capital-jd.md'), 'utf-8'), /Fetched from https:\/\/jobs\.example\.com\/acme\/swe/);
  const bad = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, fetchJd: async () => ({ ok: false, error: 'posting unavailable' }) });
  assert.deepEqual(bad.skipped.find((s) => s.path === p.ctx('acme-capital-jd.md')), { path: p.ctx('acme-capital-jd.md'), reason: 'jd-fetch-failed: posting unavailable' });
});

test('no round means no practice file; recruiter has no practice rule', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  const none = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY });
  assert.deepEqual(none.skipped, [{ path: p.practice, reason: 'no-round' }]);
  const rec = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'recruiter' });
  assert.deepEqual(rec.skipped, [{ path: p.practice, reason: 'no-practice-for-recruiter' }]);
});

test('empty round is treated as no round', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: '' });
  assert.deepEqual(r.skipped, [{ path: p.practice, reason: 'no-round' }]);
  assert.equal(r.practice, null);
});

test('roleKey preserves separators after the first one in the role title', async (t) => {
  const { dataDir, interviewHome, p } = setup(t, { workbook: false, tailored: false });
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: 'Acme Capital|Engineer | Platform' });
  assert.ok(r.written.includes(p.ctx('target.md')));
  assert.match(fs.readFileSync(p.ctx('target.md'), 'utf-8'), /Title and level I am targeting: Engineer \| Platform/);
});

test('rejects a malformed roleKey and an unknown round', async (t) => {
  const { dataDir, interviewHome } = setup(t, { workbook: false });
  for (const roleKey of ['NoPipe', '', '|Engineer', 'Acme| ', {}, null]) {
    await assert.rejects(writeInterviewContext({ dataDir, interviewHome, roleKey }), (e) => e.code === 'INPUT');
  }
  await assert.rejects(writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'lunch' }), (e) => e.code === 'INPUT');
});

test('corrupt master is reported with its error and the other files still get written', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  const file = path.join(dataDir, 'resume', 'master.json');
  fs.writeFileSync(file, '{broken');
  let message;
  try { require('../lib/interview/resume-bridge').readMasterResume(dataDir); }
  catch (error) { message = error.message; }
  assert.ok(message);
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
  assert.deepEqual(r.skipped, [{ path: p.ctx('resume.md'), reason: `master-resume-invalid: ${message}` }]);
  assert.deepEqual(r.written.slice().sort(), [p.ctx('acme-capital-jd.md'), p.ctx('target.md'), p.cheatsheet, p.practice].sort());
  assert.equal(fs.existsSync(p.ctx('resume.md')), false);
});

test('user-owned practice uses the generated sibling path', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  fs.mkdirSync(path.dirname(p.practice), { recursive: true });
  fs.writeFileSync(p.practice, '{"mine":true}');
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
  const sibling = p.practice.replace(/\.json$/, '.jq.json');
  assert.equal(r.practice, sibling);
  assert.deepEqual(r.skipped, [{ path: p.practice, reason: 'user-owned', wroteInstead: sibling }]);
  assert.deepEqual(readJson(p.practice), { mine: true });
  assert.deepEqual(readJson(sibling).questions.map((q) => q.qid), ['c1']);
});

test('user-owned targets and siblings are preserved and every blocked skip is reported', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  const targets = [p.ctx('target.md'), p.cheatsheet, p.practice];
  for (const file of targets) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'user target');
    fs.writeFileSync(file.replace(/(\.[^.]+)$/, '.jq$1'), 'user sibling');
  }
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
  assert.deepEqual(r.skipped, targets.map((file) => ({ path: file, reason: 'user-owned', wroteInstead: null, siblingUserOwned: true })));
  assert.equal(r.cheatsheet, p.cheatsheet);
  assert.equal(r.practice, null);
  for (const file of targets) {
    assert.equal(fs.readFileSync(file, 'utf8'), 'user target');
    assert.equal(fs.readFileSync(file.replace(/(\.[^.]+)$/, '.jq$1'), 'utf8'), 'user sibling');
  }
});

test('creates missing target directories before writing', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  fs.rmSync(interviewHome, { recursive: true });
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
  assert.equal(r.written.length, 5);
  assert.deepEqual(r.skipped, []);
  assert.ok(fs.existsSync(p.practice));
});

test('roleIds uses P0 slugs even for accents, punctuation, and empty slug inputs', () => {
  assert.deepEqual(roleIds({ company: 'Acme Capital', role: 'Software Engineer' }), { companySlug: 'acme-capital', roleId: ROLE_ID });
  for (const role of [
    { company: 'Àcme / ../ Capital', role: 'C++ Engineer' },
    { company: '!!!', role: '???' },
    { company: 'A'.repeat(100), role: 'Engineer' },
  ]) {
    for (const id of Object.values(roleIds(role))) assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test('no-agent reports an unbuilt cheat sheet while still producing practice', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding', noAgent: true,
    runAgentFn: async () => assert.fail('agent must not run') });
  assert.deepEqual(r.skipped, [{ path: p.cheatsheet, reason: 'cheatsheet-not-built' }]);
  assert.equal(r.cheatsheet, null);
  assert.equal(r.practice, p.practice);
});

test('invalid cheat sheet output is reported without blocking practice', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  let calls = 0;
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding',
    runAgentFn: async ({ cwd }) => {
      calls++;
      fs.writeFileSync(path.join(cwd, 'cheatsheet.out.json'), '[]');
      return { ok: true };
    } });
  assert.equal(calls, 2);
  assert.deepEqual(r.skipped, [{ path: p.cheatsheet, reason: 'cheatsheet-invalid: no cards' }]);
  assert.equal(r.practice, p.practice);
});

for (const ownership of ['owned', 'user-owned', 'blocked-sibling']) {
  test(`stale cached cheat sheet is reported and respects ${ownership} files`, async (t) => {
    const { dataDir, interviewHome, p } = setup(t);
    await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
    const previous = readJson(p.cheatsheet);
    const wb = require('../lib/interview/workbook-bridge').findWorkbook(dataDir, ROLE_KEY);
    fs.appendFileSync(path.join(wb.dir, 'content', '01-coding-basics.md'), '\nChanged workbook.\n');
    const sibling = p.cheatsheet.replace(/\.json$/, '.jq.json');
    if (ownership !== 'owned') fs.writeFileSync(p.cheatsheet, '{"mine":true}');
    if (ownership === 'blocked-sibling') fs.writeFileSync(sibling, '{"mine":"sibling"}');
    let calls = 0;
    const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding',
      runAgentFn: async () => { calls++; return { ok: false, code: 7 }; } });
    assert.equal(calls, 2);
    const stale = { path: p.cheatsheet, reason: 'cheatsheet-stale: cheatsheet-invalid: the agent exited with code 7' };
    if (ownership === 'owned') {
      assert.ok(r.written.includes(p.cheatsheet));
      assert.deepEqual(readJson(p.cheatsheet), previous);
      assert.deepEqual(r.skipped, [stale]);
    } else {
      assert.deepEqual(readJson(p.cheatsheet), { mine: true });
      const ownershipNote = ownership === 'user-owned'
        ? { path: p.cheatsheet, reason: 'user-owned', wroteInstead: sibling }
        : { path: p.cheatsheet, reason: 'user-owned', wroteInstead: null, siblingUserOwned: true };
      assert.deepEqual(r.skipped, [ownershipNote, stale]);
      assert.deepEqual(readJson(sibling), ownership === 'user-owned' ? previous : { mine: 'sibling' });
    }
  });
}

for (const timestamp of ['updatedAt', 'createdAt', 'mtime']) {
  test(`findTailored chooses the newest matching directory by ${timestamp}`, (t) => {
    const { dataDir } = setup(t, { workbook: false, tailored: false });
    for (const [id, date] of [['a-old', '2025-01-01T00:00:00.000Z'], ['z-new', '2026-01-01T00:00:00.000Z'], ['zz-other-role', '2027-01-01T00:00:00.000Z']]) {
      const dir = path.join(dataDir, 'resume', 'tailored', id);
      fs.mkdirSync(dir, { recursive: true });
      const meta = { roleKeys: [id === 'zz-other-role' ? 'Other|Engineer' : ROLE_KEY], status: 'done' };
      if (timestamp !== 'mtime') meta[timestamp] = date;
      // updatedAt takes precedence over a later createdAt or filesystem timestamp.
      if (timestamp === 'updatedAt') meta.createdAt = id === 'a-old' ? '2029-01-01T00:00:00.000Z' : '2024-01-01T00:00:00.000Z';
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
      fs.writeFileSync(path.join(dir, 'jd.txt'), `${id} description`);
      const mtime = new Date(timestamp === 'mtime' ? date : (id === 'a-old' ? '2029-01-01' : '2024-01-01'));
      fs.utimesSync(dir, mtime, mtime);
    }
    const result = findTailored(dataDir, ROLE_KEY);
    assert.equal(result.id, 'z-new');
    assert.equal(result.jdText, 'z-new description');
    assert.equal(result.done, true);
  });
}

test('blank-prompt workbook questions result in no-matching-questions', async (t) => {
  const { dataDir, interviewHome, p } = setup(t);
  const wb = require('../lib/interview/workbook-bridge').findWorkbook(dataDir, ROLE_KEY);
  fs.writeFileSync(path.join(wb.dir, 'content', '01-coding-basics.md'), '@@q id=empty topic="Coding" type=code diff=2\n\n@@answer\nAnswer only.\n');
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY, round: 'coding' });
  assert.deepEqual(r.skipped, [{ path: p.practice, reason: 'no-matching-questions' }]);
  assert.equal(r.practice, null);
  assert.equal(fs.existsSync(p.practice), false);
});

test('no JD source reports no-jd without fetching', async (t) => {
  const { dataDir, interviewHome, p } = setup(t, { tailored: false, workbook: false });
  seedRole(dataDir, 'applied', { url: null });
  const r = await writeInterviewContext({ dataDir, interviewHome, roleKey: ROLE_KEY,
    fetchJd: async () => assert.fail('no posting to fetch') });
  assert.deepEqual(r.skipped.find((s) => s.path === p.ctx('acme-capital-jd.md')), { path: p.ctx('acme-capital-jd.md'), reason: 'no-jd' });
});
