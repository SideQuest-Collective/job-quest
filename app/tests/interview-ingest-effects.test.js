// app/tests/interview-ingest-effects.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ingestSession, linkSession } = require('../lib/interview/ingest');
const records = require('../lib/interview/records');
const bridge = require('../lib/interview/workbook-bridge');
const { missingTaskKeys } = require('../lib/interview/task-effects');
const { sessionWorkDir } = require('../lib/interview/analysis');
const {
  makeEnv, copyFixtureSession, setSessionFields, seedTracker, seedWorkbook, installFakeAnalyst, withFakeAgent, readJson, fakeCalls, pinned,
  ROLE_KEY, FIXTURE_FOLDER,
} = require('./helpers/interview-env');

const now = pinned('2026-10-05T12:00:00');
const KEY = `interview:${FIXTURE_FOLDER}`;
const OTHER = 'Acme Capital|Data Engineer';
const entry = (stage) => ({ stage, notes: '', checklist: [], timeline: [{ date: '2026-09-10T12:00:00.000Z', event: 'Applied' }] });

function setup(t, { tagged = true, analyst = 'fixture' } = {}) {
  withFakeAgent(t);
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  seedTracker(env.dataDir, { [ROLE_KEY]: entry('applied'), [OTHER]: entry('applied') });
  const dir = copyFixtureSession(env.interviewHome);
  if (tagged) setSessionFields(dir, { roleKey: ROLE_KEY });
  const work = sessionWorkDir(env.dataDir, FIXTURE_FOLDER);
  if (analyst === 'fixture') installFakeAnalyst(env.dataDir);
  else {
    fs.mkdirSync(path.join(work, '.fake'), { recursive: true });
    fs.writeFileSync(path.join(work, '.fake', 'debrief-analyst.js'), analyst);
  }
  const ingest = (extra = {}) => ingestSession({ dataDir: env.dataDir, interviewHome: env.interviewHome, folder: FIXTURE_FOLDER, now, ...extra });
  const tracker = () => readJson(path.join(env.dataDir, 'role-tracker.json'));
  const allTasks = () => fs.readdirSync(path.join(env.dataDir, 'tasks')).flatMap((f) => readJson(path.join(env.dataDir, 'tasks', f)).tasks);
  return { ...env, dir, work, ingest, tracker, allTasks };
}

test('an edited debrief recomputes the analysis without duplicating anything', async (t) => {
  const { dataDir, dir, work, ingest, tracker, allTasks } = setup(t);
  await ingest();
  fs.appendFileSync(path.join(dir, 'debrief.md'), '\nAdded later: the follow-up round is in person.\n');
  const r = await ingest();
  assert.equal(r.status, 'ingested');
  assert.equal(fakeCalls(work)['debrief-analyst'], 2);
  assert.equal(tracker()[ROLE_KEY].timeline.filter((x) => x.key === KEY).length, 1);
  assert.equal(allTasks().filter((x) => String(x.dedupeKey).startsWith(KEY)).length, 2);
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  assert.equal(bridge.readWorkbook(dataDir, wb.id).questions.filter((q) => q.chapter === 'asked-in-interviews').length, 2);
  const history = bridge.readProgress(dataDir, wb.id).history;
  assert.equal(history['iv-202603140930-1'].length, 1);
  assert.equal(history['iv-202603140930-2'].length, 1);
  assert.equal((await ingest()).status, 'unchanged');
});

test('practice sessions record practice grades, never change the stage, and run no agent', async (t) => {
  const { dataDir, interviewHome, dir, work, ingest, tracker } = setup(t, { tagged: false });
  const wb = seedWorkbook(dataDir);
  const practiceFile = path.join(interviewHome, 'practice', 'acme-capital-software-engineer.json');
  fs.mkdirSync(path.dirname(practiceFile), { recursive: true });
  fs.writeFileSync(practiceFile, JSON.stringify({ _generatedBy: 'job-quest', contract: 'jq-interview/1', roleKey: ROLE_KEY, workbookId: wb.id, round: 'coding', questions: [] }));
  setSessionFields(dir, { roleKey: ROLE_KEY, practiceSet: practiceFile, practiceResults: [
    { qid: 'c1', grade: 'missed', note: 'forgot ties' }, { qid: 'ghost', grade: 'got', note: '' }, { qid: 's1', grade: 'meh', note: '' },
  ] });
  const r = await ingest();
  assert.equal(r.status, 'ingested');
  assert.equal(r.effects.stage, null);
  assert.deepEqual(r.effects.workbookQids, []);
  assert.deepEqual(r.effects.progress, [{ qid: 'c1', grade: 'missed', at: '2026-03-14T14:30:00.000Z', source: 'interview-practice' }]);
  assert.match(r.summary, /1 practice grade\(s\) recorded/);
  assert.equal(tracker()[ROLE_KEY].stage, 'applied');
  assert.equal(tracker()[ROLE_KEY].timeline.find((x) => x.key === KEY).event, 'Coding round with Alex, 45 min, practice');
  assert.deepEqual(bridge.readProgress(dataDir, wb.id).grades.c1, { grade: 'missed', at: '2026-03-14T14:30:00.000Z', source: 'interview-practice' });
  assert.deepEqual(records.readRecord(dataDir, FIXTURE_FOLDER).dropped.map((d) => `${d.kind}:${d.index}`), ['practiceResult:1', 'practiceResult:2']);
  assert.deepEqual(fakeCalls(work), {});
  assert.equal(fs.existsSync(path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)), false);
  assert.equal((await ingest()).status, 'unchanged');
});

test('effects lost to an external rewrite are re-applied without rerunning the agent', async (t) => {
  const { dataDir, work, ingest, tracker } = setup(t);
  await ingest();
  // The dashboard POSTs a stale copy of the tracker; the daily job replaces today's task file.
  seedTracker(dataDir, { [ROLE_KEY]: entry('applied'), [OTHER]: entry('applied') });
  fs.writeFileSync(path.join(dataDir, 'tasks', '2026-10-05.json'), JSON.stringify({ date: '2026-10-05', tasks: [{ text: 'Daily intel task', category: 'coding', completed: false }] }));
  const r = await ingest();
  assert.equal(r.status, 'ingested');
  assert.equal(tracker()[ROLE_KEY].timeline.filter((x) => x.key === KEY).length, 1);
  assert.equal(tracker()[ROLE_KEY].stage, 'onsite');
  assert.deepEqual(missingTaskKeys(dataDir, [`${KEY}:1`, `${KEY}:2`]), []);
  assert.deepEqual(readJson(path.join(dataDir, 'tasks', '2026-10-05.json')).tasks.map((x) => x.text), ['Daily intel task', 'Practice merging touching and nested intervals']);
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
  assert.equal((await ingest()).status, 'unchanged');
});

test('a deleted interview chapter is restored without rerunning the agent', async (t) => {
  const { dataDir, work, ingest } = setup(t);
  const first = await ingest();
  const qids = first.effects.workbookQids;
  assert.ok(qids.length > 0);
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  const chapter = path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE);
  const calls = fakeCalls(work)['debrief-analyst'];
  fs.rmSync(chapter);

  const restored = await ingest();
  assert.equal(restored.status, 'ingested');
  assert.ok(fs.existsSync(chapter));
  assert.deepEqual(restored.effects.workbookQids, qids);
  assert.deepEqual(bridge.readWorkbook(dataDir, wb.id).questions
    .filter((q) => q.chapter === 'asked-in-interviews').map((q) => q.id), qids);
  assert.equal(fakeCalls(work)['debrief-analyst'], calls);
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(fakeCalls(work)['debrief-analyst'], calls);
});

test('re-linking moves the timeline entry and rebuilds both chapters', async (t) => {
  const { dataDir, interviewHome, work, ingest, tracker, allTasks } = setup(t);
  await ingest();
  const wbA = bridge.findWorkbook(dataDir, ROLE_KEY);
  assert.ok(fs.existsSync(path.join(wbA.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)));
  const r = await linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey: OTHER, now });
  assert.equal(r.status, 'ingested');
  assert.equal(tracker()[ROLE_KEY].timeline.some((x) => x.key === KEY), false);
  assert.equal(tracker()[ROLE_KEY].stage, 'onsite');
  assert.equal(tracker()[OTHER].timeline.filter((x) => x.key === KEY).length, 1);
  assert.equal(tracker()[OTHER].stage, 'onsite');
  assert.equal(fs.existsSync(path.join(wbA.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)), false);
  const wbB = bridge.findWorkbook(dataDir, OTHER);
  assert.notEqual(wbB.id, wbA.id);
  assert.deepEqual(bridge.readWorkbook(dataDir, wbB.id).questions.filter((q) => q.chapter === 'asked-in-interviews').map((q) => q.id), ['iv-202603140930-1', 'iv-202603140930-2']);
  assert.equal(allTasks().filter((x) => String(x.dedupeKey).startsWith(KEY)).length, 2);
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('recruiter memory lands in the tracker notes once; an edited debrief replaces it', async (t) => {
  const analyst = "module.exports = async ({ cwd, fs, path }) => { fs.writeFileSync(path.join(cwd, 'analysis.json'), JSON.stringify({ asked: [], weakSpots: [], followUps: [{ text: 'Send the portfolio link' }] })); };";
  const { dataDir, dir, ingest, tracker } = setup(t, { analyst });
  setSessionFields(dir, { round: 'recruiter' });
  const debrief = (facts) => ['# Debrief', '', 'Round: recruiter', '', 'Total session: 20:00.', '', '## About the role', '', 'Platform team, new headcount.', '', '## Facts they said', '', facts, '', '## Follow-up', '', 'Send the portfolio link.', ''].join('\n');
  fs.writeFileSync(path.join(dir, 'debrief.md'), debrief('- Two technical rounds'));
  const r = await ingest();
  assert.deepEqual(r.effects.stage, { from: 'applied', to: 'phone-screen' });
  assert.deepEqual(r.effects.workbookQids, []);
  assert.equal(bridge.findWorkbook(dataDir, ROLE_KEY), null);
  assert.ok(tracker()[ROLE_KEY].notes.includes('[interview:2026-03-14_0930] Recruiter call 2026-03-14\nAbout the role:\nPlatform team, new headcount.\nFacts they said:\n- Two technical rounds\n[/interview:2026-03-14_0930]'));
  fs.writeFileSync(path.join(dir, 'debrief.md'), debrief('- Three technical rounds'));
  await ingest();
  const notes = tracker()[ROLE_KEY].notes;
  assert.equal(notes.match(/\[interview:2026-03-14_0930\]/g).length, 1);
  assert.ok(notes.includes('- Three technical rounds'));
  assert.ok(!notes.includes('- Two technical rounds'));
});

test('a failed analysis is retried once on the next ingest, then left alone', async (t) => {
  const { dataDir, work, ingest, tracker } = setup(t, { analyst: "module.exports = async () => { throw new Error('agent broke'); };" });
  const r1 = await ingest();
  assert.equal(r1.status, 'ingested');
  assert.match(r1.summary, /debrief analysis failed and will be retried/);
  assert.equal(tracker()[ROLE_KEY].timeline.filter((x) => x.key === KEY).length, 1);
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).analysisAttempts, 1);
  const r2 = await ingest();
  assert.equal(r2.status, 'ingested');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).analysisAttempts, 2);
  assert.equal(fakeCalls(work)['debrief-analyst'], 4);
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(fakeCalls(work)['debrief-analyst'], 4);
});

test('rejected qids do not force endless reapplication', async (t) => {
  const { dataDir, ingest, work } = setup(t);
  const recordGrades = bridge.recordGrades;
  t.mock.method(bridge, 'recordGrades', (dataDir, id, grades) => {
    const result = recordGrades(dataDir, id, grades.slice(0, 1));
    return { ...result, rejected: [{ qid: grades[1].qid, reason: 'question does not exist in this workbook' }] };
  });
  assert.match((await ingest()).summary, /1 grade\(s\) rejected/);
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.deepEqual(rec.effects.progress.map((g) => g.qid), ['iv-202603140930-1']);
  assert.deepEqual(rec.gradeRejected, [{ qid: 'iv-202603140930-2', reason: 'question does not exist in this workbook' }]);
  assert.equal(bridge.readProgress(dataDir, rec.workbookId).history['iv-202603140930-2'], undefined);
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('missing tasks alone are repaired and deleted workbooks are skipped', async (t) => {
  const { dataDir, ingest, work } = setup(t);
  await ingest();
  fs.rmSync(path.join(dataDir, 'tasks', '2026-10-09.json'));
  assert.equal((await ingest()).status, 'ingested');
  assert.deepEqual(missingTaskKeys(dataDir, [`${KEY}:1`, `${KEY}:2`]), []);
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  fs.rmSync(wb.dir, { recursive: true });
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(fs.existsSync(wb.dir), false);
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('practice falls back to the role workbook and repairs missing history through recordGrades', async (t) => {
  const { dataDir, dir, ingest, work } = setup(t);
  const wb = seedWorkbook(dataDir);
  setSessionFields(dir, { practiceSet: path.join(dir, 'missing-practice.json'), practiceResults: [{ qid: 'c1', grade: 'got' }] });
  const writer = t.mock.method(bridge, 'recordGrades');
  await ingest();
  assert.equal(writer.mock.calls.length, 1);
  assert.deepEqual(writer.mock.calls[0].arguments[2], [{ qid: 'c1', grade: 'got', at: '2026-03-14T14:30:00.000Z', source: 'interview-practice' }]);
  const file = path.join(wb.dir, 'progress.json');
  const progress = readJson(file);
  progress.history.c1 = [];
  fs.writeFileSync(file, JSON.stringify(progress));
  assert.equal((await ingest()).status, 'ingested');
  assert.equal(bridge.readProgress(dataDir, wb.id).history.c1.length, 1);
  assert.equal((await ingest()).status, 'unchanged');
  assert.deepEqual(fakeCalls(work), {});
});

test('recruiter memory strips embedded markers and preserves notes edited during analysis', async (t) => {
  const { dir, ingest, tracker, dataDir } = setup(t);
  setSessionFields(dir, { round: 'recruiter' });
  const debrief = path.join(dir, 'debrief.md');
  fs.writeFileSync(debrief, `# Debrief\n\n## About the role\n\nPlatform [${KEY}] team [/${KEY}] hiring.\n`);
  const runAgentFn = async ({ cwd }) => {
    const entries = tracker();
    entries[ROLE_KEY].notes = 'User notes saved during analysis';
    seedTracker(dataDir, entries);
    fs.writeFileSync(path.join(cwd, 'analysis.json'), JSON.stringify({ asked: [], weakSpots: [], followUps: [] }));
    return { ok: true };
  };
  await ingest({ runAgentFn });
  fs.appendFileSync(debrief, '\nAnother fact.\n');
  await ingest({ runAgentFn });
  const notes = tracker()[ROLE_KEY].notes;
  assert.ok(notes.startsWith('User notes saved during analysis'));
  assert.equal(notes.split(`[${KEY}]`).length - 1, 1);
  assert.equal(notes.split(`[/${KEY}]`).length - 1, 1);
  assert.ok(notes.includes('Another fact.'));
});

test('edited debrief grades replace latest values using stored effect timestamps', async (t) => {
  const { dataDir, dir, ingest } = setup(t);
  let calls = 0;
  const runAgentFn = async ({ cwd, prompt }) => {
    calls++;
    await require('./fixtures/interview/fake-analyst')({ cwd, fs, path, prompt, attempt: calls });
    const file = path.join(cwd, 'analysis.json');
    const analysis = readJson(file);
    analysis.asked[0].grade = calls === 1 ? 'missed' : 'got';
    if (calls > 1) analysis.asked[1].grade = 'missed';
    fs.writeFileSync(file, JSON.stringify(analysis));
    return { ok: true };
  };
  await ingest({ runAgentFn });
  fs.appendFileSync(path.join(dir, 'debrief.md'), '\nCorrected assessment.\n');
  const r = await ingest({ runAgentFn });
  const progress = bridge.readProgress(dataDir, bridge.findWorkbook(dataDir, ROLE_KEY).id);
  assert.equal(progress.grades['iv-202603140930-1'].grade, 'got');
  assert.equal(progress.grades['iv-202603140930-2'].grade, 'missed');
  assert.ok(r.effects.progress.every((p) => p.at === now().toISOString()));
  assert.equal((await ingest({ runAgentFn })).status, 'unchanged');
  assert.equal(calls, 2);
});

test('a failed re-link retries old-role cleanup without rerunning analysis', async (t) => {
  const { dataDir, interviewHome, ingest, work, tracker } = setup(t);
  await ingest();
  const oldWorkbook = bridge.findWorkbook(dataDir, ROLE_KEY);
  const history = bridge.readProgress(dataDir, oldWorkbook.id).history;
  const trackerFx = require('../lib/interview/tracker-effects');
  const write = t.mock.method(trackerFx, 'writeTracker', () => { throw new Error('tracker write failed'); });
  await assert.rejects(linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey: OTHER, now }), /tracker write failed/);
  write.mock.restore();
  assert.equal((await ingest()).status, 'ingested');
  assert.equal(tracker()[ROLE_KEY].timeline.some((e) => e.key === KEY), false);
  assert.equal(tracker()[ROLE_KEY].stage, 'onsite');
  assert.equal(fs.existsSync(path.join(oldWorkbook.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)), false);
  assert.deepEqual(bridge.readProgress(dataDir, oldWorkbook.id).history, history);
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('changing a session to practice does not retain a prior stage effect', async (t) => {
  const { dataDir, dir, ingest } = setup(t);
  await ingest();
  seedWorkbook(dataDir);
  setSessionFields(dir, { practiceSet: path.join(dir, 'missing-practice.json'), practiceResults: [{ qid: 'c1', grade: 'got' }] });
  const result = await ingest();
  assert.equal(result.effects.stage, null);
  assert.deepEqual(result.effects.workbookQids, []);
});


test('clobbered recruiter notes are repaired without rerunning the analyst', async (t) => {
  const { dataDir, dir, ingest, tracker, work } = setup(t);
  setSessionFields(dir, { round: 'recruiter' });
  fs.writeFileSync(path.join(dir, 'debrief.md'), '# Debrief\n\n## About the role\n\nPlatform team hiring.\n');
  await ingest();
  const entries = tracker();
  entries[ROLE_KEY].notes = 'User edited notes';
  seedTracker(dataDir, entries);
  assert.equal((await ingest()).status, 'ingested');
  assert.match(tracker()[ROLE_KEY].notes, /User edited notes/);
  assert.ok(tracker()[ROLE_KEY].notes.includes(`[${KEY}]`));
  assert.ok(tracker()[ROLE_KEY].notes.includes('Platform team hiring.'));
  assert.ok(tracker()[ROLE_KEY].notes.includes(`[/${KEY}]`));
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).effects.recruiterMemory, true);
  assert.equal((await ingest()).status, 'unchanged');
  // Older records predate the persisted recruiter-memory effect.
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  delete rec.effects.recruiterMemory;
  records.writeRecord(dataDir, rec);
  entries[ROLE_KEY].notes = 'User edited notes again';
  seedTracker(dataDir, entries);
  assert.equal((await ingest()).status, 'ingested');
  assert.ok(tracker()[ROLE_KEY].notes.includes(`[${KEY}]`));
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('rejected grades cannot exempt a recorded progress effect from repair', async (t) => {
  const { dataDir, ingest } = setup(t);
  await ingest();
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  const progressFile = path.join(bridge.findWorkbook(dataDir, ROLE_KEY).dir, 'progress.json');
  const progress = readJson(progressFile);
  const qid = rec.effects.progress[0].qid;
  delete progress.history[qid];
  fs.writeFileSync(progressFile, JSON.stringify(progress));
  rec.gradeRejected = [{ qid, reason: 'old rejection' }];
  assert.equal(require('../lib/interview/ingest').isApplied(dataDir, rec), false);
});

test('practice progress effects include only accepted grades and retain rejections for display', async (t) => {
  const { dataDir, dir, ingest, work } = setup(t);
  const wb = seedWorkbook(dataDir);
  setSessionFields(dir, { practiceSet: path.join(dir, 'missing-practice.json'), practiceResults: [
    { qid: 'c1', grade: 'got' }, { qid: 's1', grade: 'partial' },
  ] });
  const recordGrades = bridge.recordGrades;
  t.mock.method(bridge, 'recordGrades', (dataDir, id, grades) => ({
    ...recordGrades(dataDir, id, grades.filter((g) => g.qid === 'c1')),
    rejected: [{ qid: 's1', reason: 'question does not exist in this workbook' }],
  }));
  const result = await ingest();
  assert.deepEqual(result.effects.progress, [{ qid: 'c1', grade: 'got', at: '2026-03-14T14:30:00.000Z', source: 'interview-practice' }]);
  assert.deepEqual(records.readRecord(dataDir, FIXTURE_FOLDER).gradeRejected, [{ qid: 's1', reason: 'question does not exist in this workbook' }]);
  assert.equal(bridge.readProgress(dataDir, wb.id).history.s1, undefined);
  assert.equal((await ingest()).status, 'unchanged');
  assert.deepEqual(fakeCalls(work), {});
});


test('recruiter sessions without memory do not require a notes block', async (t) => {
  const { dataDir, dir, ingest } = setup(t);
  setSessionFields(dir, { round: 'recruiter' });
  fs.writeFileSync(path.join(dir, 'debrief.md'), '# Debrief\n\nNo role details recorded.\n');
  const runAgentFn = async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'analysis.json'), JSON.stringify({ asked: [], weakSpots: [], followUps: [] }));
    return { ok: true };
  };
  assert.equal((await ingest({ runAgentFn })).status, 'ingested');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).effects.recruiterMemory, undefined);
  assert.equal((await ingest({ runAgentFn })).status, 'unchanged');
});

for (const invalid of ['outside', 'traversal', 'symlink', 'directory-symlink', 'extension', 'resolved-extension', 'missing-workbook']) {
  test(`practiceSet ${invalid} falls back to the role workbook and records why`, async (t) => {
    const { dataDir, interviewHome, dir, ingest } = setup(t);
    const wb = seedWorkbook(dataDir);
    const other = seedWorkbook(dataDir, OTHER);
    const practice = path.join(interviewHome, 'practice');
    fs.mkdirSync(practice, { recursive: true });
    let file = path.join(practice, 'set.json');
    const set = { workbookId: other.id };
    if (invalid === 'outside' || invalid === 'traversal') {
      file = invalid === 'outside' ? path.join(interviewHome, 'outside.json') : `${practice}/../outside.json`;
    } else if (invalid === 'extension') file = path.join(practice, 'set.txt');
    else if (invalid === 'missing-workbook') set.workbookId = 'deleted-workbook';
    if (invalid === 'symlink' || invalid === 'resolved-extension') {
      const target = invalid === 'symlink' ? path.join(interviewHome, 'outside.json') : path.join(practice, 'set.txt');
      fs.writeFileSync(target, JSON.stringify(set));
      fs.symlinkSync(target, file);
    } else if (invalid === 'directory-symlink') {
      const target = path.join(interviewHome, 'outside');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'set.json'), JSON.stringify(set));
      fs.symlinkSync(target, path.join(practice, 'linked'));
      file = path.join(practice, 'linked', 'set.json');
    } else fs.writeFileSync(file, JSON.stringify(set));
    setSessionFields(dir, { practiceSet: file, practiceResults: [{ qid: 'c1', grade: 'got' }] });
    const result = await ingest();
    const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
    assert.equal(rec.workbookId, wb.id);
    assert.equal(rec.dropped.length, 1);
    assert.equal(rec.dropped[0].kind, 'practiceSet');
    assert.match(rec.dropped[0].reason, invalid === 'missing-workbook' ? /workbook.*(missing|not found|no longer exists)/i
      : /practice|\.json/i);
    assert.match(result.summary, /practice set.*fall.*back/i);
    assert.equal(bridge.readProgress(dataDir, wb.id).grades.c1.grade, 'got');
    assert.equal(bridge.readProgress(dataDir, other.id).grades.c1, undefined);
  });
}

test('practiceSet accepts a real path inside practice even when it names a different workbook', async (t) => {
  const { dataDir, interviewHome, dir, ingest } = setup(t);
  seedWorkbook(dataDir);
  const wb = seedWorkbook(dataDir, OTHER);
  const practice = path.join(interviewHome, 'practice');
  fs.mkdirSync(practice, { recursive: true });
  const target = path.join(practice, 'set.json');
  const alias = path.join(practice, 'alias.json');
  fs.writeFileSync(target, JSON.stringify({ workbookId: wb.id }));
  fs.symlinkSync(target, alias);
  setSessionFields(dir, { practiceSet: alias, practiceResults: [{ qid: 'c1', grade: 'got' }] });
  await ingest();
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.equal(rec.workbookId, wb.id);
  assert.deepEqual(rec.dropped, []);
  assert.equal(bridge.readProgress(dataDir, wb.id).grades.c1.grade, 'got');
});

test('ingest completes pendingCleanup when the old workbook metadata is corrupt', async (t) => {
  const { dataDir, interviewHome, ingest } = setup(t);
  await ingest();
  const previous = records.readRecord(dataDir, FIXTURE_FOLDER);
  const oldDir = path.join(dataDir, 'workbooks', previous.workbookId);
  fs.writeFileSync(path.join(oldDir, 'meta.json'), '{broken');
  const lines = [];
  t.mock.method(console, 'warn', (line) => lines.push(line));
  const result = await linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey: OTHER, now });
  assert.equal(result.status, 'ingested');
  assert.equal(fs.existsSync(path.join(oldDir, 'content', bridge.INTERVIEW_CHAPTER_FILE)), false);
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).pendingCleanup, undefined);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(previous.workbookId));
});
