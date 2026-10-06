// app/tests/interview-ingest.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ingestSession, linkSession, rebuildInterviewChapter, isApplied } = require('../lib/interview/ingest');
const records = require('../lib/interview/records');
const bridge = require('../lib/interview/workbook-bridge');
const { sessionWorkDir } = require('../lib/interview/analysis');
const {
  makeEnv, copyFixtureSession, setSessionFields, seedRole, installFakeAnalyst, withFakeAgent, readJson, fakeCalls, pinned,
  ROLE_KEY, FIXTURE_FOLDER,
} = require('./helpers/interview-env');

const now = pinned('2026-10-05T12:00:00');
const KEY = `interview:${FIXTURE_FOLDER}`;
const Q1 = 'iv-202603140930-1';
const Q2 = 'iv-202603140930-2';

function setup(t, { tagged = false } = {}) {
  withFakeAgent(t);
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  seedRole(env.dataDir, 'applied');
  const dir = copyFixtureSession(env.interviewHome);
  if (tagged) setSessionFields(dir, { roleKey: ROLE_KEY });
  installFakeAnalyst(env.dataDir);
  const ingest = (extra = {}) => ingestSession({ dataDir: env.dataDir, interviewHome: env.interviewHome, folder: FIXTURE_FOLDER, now, ...extra });
  return { ...env, dir, ingest, work: sessionWorkDir(env.dataDir, FIXTURE_FOLDER) };
}

function snapshot(dataDir) {
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null);
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  return {
    tracker: read(path.join(dataDir, 'role-tracker.json')),
    today: read(path.join(dataDir, 'tasks', '2026-10-05.json')),
    due: read(path.join(dataDir, 'tasks', '2026-10-09.json')),
    chapter: wb ? read(path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)) : null,
    progress: wb ? JSON.stringify(bridge.readProgress(dataDir, wb.id)) : null,
  };
}

test('an unlinked session is recorded and touches nothing else', async (t) => {
  const { dataDir, ingest, work } = setup(t);
  const before = fs.readFileSync(path.join(dataDir, 'role-tracker.json'), 'utf-8');
  const r = await ingest();
  assert.equal(r.status, 'unlinked');
  assert.deepEqual(r.effects, { timeline: [], stage: null, workbookQids: [], tasks: [], progress: [] });
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.equal(rec.status, 'unlinked');
  assert.equal(rec.roleKey, null);
  assert.equal(rec.round, 'coding');
  assert.equal(fs.readFileSync(path.join(dataDir, 'role-tracker.json'), 'utf-8'), before);
  assert.equal(fs.existsSync(path.join(dataDir, 'tasks')), false);
  assert.deepEqual(fakeCalls(work), {});
  const again = await ingest({ now: pinned('2026-10-06T08:00:00') });
  assert.equal(again.status, 'unlinked');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).ingestedAt, rec.ingestedAt);
});

test('a tagged session is ingested: timeline, stage, workbook chapter, progress, tasks', async (t) => {
  const { dataDir, dir, ingest } = setup(t, { tagged: true });
  const r = await ingest();
  assert.equal(r.status, 'ingested');
  assert.deepEqual(r.effects, {
    timeline: [KEY],
    stage: { from: 'applied', to: 'onsite' },
    workbookQids: [Q1, Q2],
    tasks: [`${KEY}:1`, `${KEY}:2`],
    progress: [{ qid: Q1, grade: 'got', at: '2026-03-14T14:30:00.000Z' }, { qid: Q2, grade: 'partial', at: '2026-03-14T14:30:00.000Z' }],
  });
  assert.equal(r.summary, 'Ingested 2026-03-14_0930 into Acme Capital — Software Engineer: timeline updated, stage applied -> onsite, 2 question(s) in the workbook, 2 follow-up task(s).');

  const entry = readJson(path.join(dataDir, 'role-tracker.json'))[ROLE_KEY];
  assert.equal(entry.stage, 'onsite');
  assert.deepEqual(entry.timeline.find((x) => x.key === KEY), { date: '2026-03-14T14:30:00.000Z', event: 'Coding round with Alex, 45 min', key: KEY });

  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  assert.equal(wb.meta.source, 'interview');
  const asked = bridge.readWorkbook(dataDir, wb.id).questions.filter((q) => q.chapter === 'asked-in-interviews');
  assert.deepEqual(asked.map((q) => q.id), [Q1, Q2]);
  const chapter = fs.readFileSync(path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE), 'utf-8');
  assert.ok(chapter.includes('- 2026-03-14: Coding round with Alex, 45 min (2 questions)'));
  const progress = bridge.readProgress(dataDir, wb.id);
  assert.deepEqual(progress.grades[Q2], { grade: 'partial', at: '2026-03-14T14:30:00.000Z', source: 'interview' });

  assert.deepEqual(readJson(path.join(dataDir, 'tasks', '2026-10-05.json')).tasks.map((x) => [x.dedupeKey, x.category]), [[`${KEY}:1`, 'application']]);
  assert.deepEqual(readJson(path.join(dataDir, 'tasks', '2026-10-09.json')).tasks.map((x) => x.dedupeKey), [`${KEY}:2`]);

  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.equal(rec.status, 'ingested');
  assert.equal(rec.applied, true);
  assert.equal(rec.hash, records.sessionHash(dir));
  assert.equal(rec.workbookId, wb.id);
  assert.equal(rec.interviewer, 'Alex');
  assert.equal(rec.durationMin, 45);
  assert.equal(rec.analysis.asked.length, 2);
});

test('ingesting the same session again is a no-op returning unchanged', async (t) => {
  const { dataDir, ingest, work } = setup(t, { tagged: true });
  await ingest();
  const before = snapshot(dataDir);
  const r = await ingest({ now: pinned('2026-10-06T08:00:00') });
  assert.equal(r.status, 'unchanged');
  assert.deepEqual(r.effects.tasks, [`${KEY}:1`, `${KEY}:2`]);
  assert.deepEqual(snapshot(dataDir), before);
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('link-session links an unlinked session and ingests it', async (t) => {
  const { dataDir, interviewHome, ingest } = setup(t);
  assert.equal((await ingest()).status, 'unlinked');
  const r = await linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey: ROLE_KEY, now });
  assert.equal(r.status, 'ingested');
  assert.deepEqual(r.effects.timeline, [KEY]);
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.equal(rec.roleKey, ROLE_KEY);
  assert.deepEqual(rec.link, { roleKey: ROLE_KEY, at: now().toISOString() });
  assert.equal((await ingest()).status, 'unchanged');
});

test('link-session preserves separators after the first one in the role title', async (t) => {
  const { dataDir, interviewHome } = setup(t);
  const roleKey = 'Acme Capital|Software Engineer | Platform';
  fs.writeFileSync(path.join(dataDir, 'role-tracker.json'), JSON.stringify({
    [roleKey]: { stage: 'applied', url: '' },
  }));
  const result = await linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey, now });
  assert.equal(result.status, 'ingested');
  const record = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.equal(record.roleKey, roleKey);
  assert.equal(record.link.roleKey, roleKey);
  assert.match(result.summary, /Software Engineer \| Platform/);
});

test('a legacy session is treated as unlinked until linked; its own roleKey field is ignored', async (t) => {
  const { dataDir, interviewHome, dir, ingest } = setup(t);
  setSessionFields(dir, { contractVersion: undefined, practiceSet: undefined, practiceResults: undefined, endedAt: undefined, roleKey: 'Other Co|Role' });
  assert.equal((await ingest()).status, 'unlinked');
  const r = await linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey: ROLE_KEY, now });
  assert.equal(r.status, 'ingested');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).roleKey, ROLE_KEY);
});

test('link-session rejects malformed and unknown role keys without writing', async (t) => {
  const { dataDir, interviewHome } = setup(t);
  for (const roleKey of ['nopipe', '', '|Engineer', 'Acme| ', {}, null]) {
    await assert.rejects(linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey, now }), (e) => e.code === 'INPUT' && /roleKey must look like/.test(e.message));
  }
  await assert.rejects(linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey: 'Nobody|Role', now }), (e) => e.code === 'INPUT' && /unknown roleKey/.test(e.message));
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER), null);
});

test('a different contract major is refused before anything is written', async (t) => {
  const { dataDir, dir, ingest } = setup(t, { tagged: true });
  setSessionFields(dir, { contractVersion: 'jq-interview/2' });
  await assert.rejects(ingest(), (e) => e.code === 'CONTRACT');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER), null);
});

test('folder may be a name or an absolute path; unknown and malformed folders are rejected', async (t) => {
  const { dataDir, interviewHome, dir } = setup(t);
  assert.equal((await ingestSession({ dataDir, interviewHome, folder: dir, now })).status, 'unlinked');
  await assert.rejects(ingestSession({ dataDir, interviewHome, folder: '2020-01-01_0000', now }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(ingestSession({ dataDir, interviewHome, folder: '../../etc', now }), (e) => e.code === 'INPUT');
});

// Run the same fixture analyst in-process so tests can edit its output or the
// live tracker during the agent call, without accessing installed user data.
function scriptedAnalyst(edit = () => {}) {
  let calls = 0;
  const runAgentFn = async ({ cwd, prompt }) => {
    calls++;
    await require('./fixtures/interview/fake-analyst')({ cwd, fs, path, prompt, attempt: calls });
    const file = path.join(cwd, 'analysis.json');
    const analysis = readJson(file);
    await edit({ calls, analysis });
    fs.writeFileSync(file, JSON.stringify(analysis));
    return { ok: true };
  };
  return { runAgentFn, calls: () => calls };
}

test('an edited debrief replaces a changed latest grade and retains unchanged timestamps', async (t) => {
  const { dataDir, dir, ingest } = setup(t, { tagged: true });
  const agent = scriptedAnalyst(({ calls, analysis }) => {
    if (calls > 1) analysis.asked[1].grade = 'missed';
  });
  await ingest(agent);
  fs.appendFileSync(path.join(dir, 'debrief.md'), '\nEdited assessment.\n');
  const r = await ingest(agent);
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  const progress = bridge.readProgress(dataDir, wb.id);
  assert.equal(progress.grades[Q2].grade, 'missed');
  assert.equal(progress.grades[Q2].at, now().toISOString());
  assert.deepEqual(r.effects.progress, [
    { qid: Q1, grade: 'got', at: '2026-03-14T14:30:00.000Z' },
    { qid: Q2, grade: 'missed', at: now().toISOString() },
  ]);
  assert.equal(progress.history[Q1].length, 1);
  assert.equal(progress.history[Q2].length, 2);
  assert.equal(isApplied(dataDir, records.readRecord(dataDir, FIXTURE_FOLDER)), true);
  assert.equal((await ingest(agent)).status, 'unchanged');
  assert.equal(agent.calls(), 2);

  // A later edit with the same grades retains the regrade timestamp too.
  fs.appendFileSync(path.join(dir, 'debrief.md'), '\nClarification.\n');
  assert.deepEqual((await ingest(agent)).effects.progress, r.effects.progress);
  assert.deepEqual(bridge.readProgress(dataDir, wb.id).history, progress.history);
});

test('isApplied uses each stored effect timestamp and repairs missing progress without analysis', async (t) => {
  const { dataDir, ingest, work } = setup(t, { tagged: true });
  await ingest();
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  const file = path.join(wb.dir, 'progress.json');
  const progress = readJson(file);
  progress.history[Q2][0].at = now().toISOString();
  fs.writeFileSync(file, JSON.stringify(progress));
  assert.equal(isApplied(dataDir, rec), false);
  assert.equal((await ingest()).status, 'ingested');
  assert.equal(isApplied(dataDir, records.readRecord(dataDir, FIXTURE_FOLDER)), true);
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('tracker effects preserve edits made while the analyst runs, inside the folder lock', async (t) => {
  const { dataDir, ingest } = setup(t, { tagged: true });
  const file = path.join(dataDir, 'role-tracker.json');
  const agent = scriptedAnalyst(() => {
    assert.equal(fs.existsSync(path.join(records.recordsDir(dataDir), `.${FIXTURE_FOLDER}.lock`)), true);
    const tracker = readJson(file);
    tracker[ROLE_KEY].notes = 'Updated while the analyst was running';
    tracker['Other Co|Role'] = { stage: 'saved', timeline: [] };
    fs.writeFileSync(file, JSON.stringify(tracker));
  });
  await ingest(agent);
  assert.equal(readJson(file)[ROLE_KEY].notes, 'Updated while the analyst was running');
  assert.deepEqual(readJson(file)['Other Co|Role'], { stage: 'saved', timeline: [] });
});

test('a dashboard clobber of either timeline or stage is repaired without rerunning the analyst', async (t) => {
  const { dataDir, ingest, work } = setup(t, { tagged: true });
  await ingest();
  const file = path.join(dataDir, 'role-tracker.json');
  for (const field of ['timeline', 'stage']) {
    const tracker = readJson(file);
    if (field === 'timeline') tracker[ROLE_KEY].timeline = [];
    else tracker[ROLE_KEY].stage = 'applied';
    fs.writeFileSync(file, JSON.stringify(tracker));
    assert.equal(isApplied(dataDir, records.readRecord(dataDir, FIXTURE_FOLDER)), false);
    assert.equal((await ingest()).status, 'ingested');
    assert.equal(readJson(file)[ROLE_KEY].stage, 'onsite');
    assert.equal(readJson(file)[ROLE_KEY].timeline.filter((e) => e.key === KEY).length, 1);
  }
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('a corrupt tracker reports its path, leaves ingestion retryable, and retains analysis', async (t) => {
  const { dataDir, ingest } = setup(t, { tagged: true });
  const file = path.join(dataDir, 'role-tracker.json');
  const original = fs.readFileSync(file, 'utf-8');
  const agent = scriptedAnalyst(() => fs.writeFileSync(file, '{broken'));
  await assert.rejects(ingest(agent), (e) => e.message.includes(file));
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.notEqual(rec.status, 'ingested');
  assert.equal(rec.applied, false);
  assert.equal(rec.analysis.asked.length, 2);
  assert.equal(fs.readFileSync(file, 'utf-8'), '{broken');
  fs.writeFileSync(file, original);
  assert.equal((await ingest(agent)).status, 'ingested');
  assert.equal(agent.calls(), 1);

  fs.writeFileSync(file, '{broken again');
  await assert.rejects(ingest(agent), (e) => e.message.includes(file));
  assert.notEqual(records.readRecord(dataDir, FIXTURE_FOLDER).status, 'ingested');
  fs.writeFileSync(file, original);
  assert.equal((await ingest(agent)).status, 'ingested');
  assert.equal(agent.calls(), 1);
});

test('relinking an unchanged hash reuses the prior analysis and prefers the saved link', async (t) => {
  const { dataDir, interviewHome, ingest, work } = setup(t, { tagged: true });
  await ingest();
  const other = 'Other Co|Role';
  const file = path.join(dataDir, 'role-tracker.json');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), [other]: { stage: 'applied', timeline: [] } }));
  assert.equal((await linkSession({ dataDir, interviewHome, folder: FIXTURE_FOLDER, roleKey: other, now })).status, 'ingested');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).roleKey, other);
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('grade writes use recordGrades and expose rejected grades in the summary', async (t) => {
  const { ingest } = setup(t, { tagged: true });
  const recordGrades = bridge.recordGrades;
  t.mock.method(bridge, 'recordGrades', (dataDir, id, grades) => {
    assert.ok(grades.every((g) => g.source === 'interview'));
    const r = recordGrades(dataDir, id, grades.slice(0, 1));
    return { ...r, rejected: [{ qid: Q2, reason: 'question does not exist in this workbook' }] };
  });
  const r = await ingest();
  assert.match(r.summary, /1 grade\(s\) rejected/);
  assert.ok(r.summary.includes(Q2));
  assert.match(r.summary, /question does not exist/);
});

test('rebuilding the chapter sorts eligible records, bumps metadata, and removes an empty chapter', async (t) => {
  const { dataDir, ingest } = setup(t, { tagged: true });
  await ingest();
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  const metaFile = path.join(wb.dir, 'meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({ ...readJson(metaFile), updatedAt: '2000-01-01T00:00:00.000Z' }));
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  records.writeRecord(dataDir, { ...rec, folder: '2026-03-13_0930' });
  records.writeRecord(dataDir, { ...rec, folder: '2026-03-12_0930', practice: true });
  records.writeRecord(dataDir, { ...rec, folder: '2026-03-11_0930', status: 'unlinked' });
  rebuildInterviewChapter(dataDir, wb.id);
  const qids = bridge.readWorkbook(dataDir, wb.id).questions.map((q) => q.id);
  assert.deepEqual(qids, ['iv-202603130930-1', 'iv-202603130930-2', Q1, Q2]);
  assert.ok(readJson(metaFile).updatedAt > '2000-01-01T00:00:00.000Z');
  for (const r of records.listRecords(dataDir)) records.writeRecord(dataDir, { ...r, status: 'unlinked' });
  rebuildInterviewChapter(dataDir, wb.id);
  assert.equal(fs.existsSync(path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)), false);
});

test('lockWaitMs is forwarded as waitMs and concurrent ingestion runs analysis once', async (t) => {
  const { dataDir, ingest, work } = setup(t, { tagged: true });
  await records.withLock(dataDir, FIXTURE_FOLDER, async () => {
    await assert.rejects(ingest({ lockWaitMs: 0 }), /busy: another ingest/);
  });
  const results = await Promise.all([ingest(), ingest()]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['ingested', 'unchanged']);
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});

test('a failed analysis is retried once per hash, then cached even when effects must be reapplied', async (t) => {
  const { dataDir, ingest } = setup(t, { tagged: true });
  let calls = 0;
  const runAgentFn = async () => { calls++; return { ok: false, code: 1 }; };
  const first = await ingest({ runAgentFn });
  assert.match(first.summary, /debrief analysis failed/);
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).analysisAttempts, 1);
  assert.equal(calls, 2); // Task 12 owns one validation/runtime retry per analysis.
  assert.equal((await ingest({ runAgentFn })).status, 'ingested');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).analysisAttempts, 2);
  assert.equal(calls, 4);
  assert.equal((await ingest({ runAgentFn })).status, 'unchanged');
  assert.equal(calls, 4);
  seedRole(dataDir);
  assert.equal((await ingest({ runAgentFn })).status, 'ingested');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).analysisAttempts, 2);
  assert.equal(calls, 4);
  assert.equal((await ingest({ runAgentFn })).status, 'unchanged');
  assert.equal(calls, 4);
});

test('failed re-analysis preserves successful questions and grades through the one retry per hash', async (t) => {
  const { dataDir, dir, ingest } = setup(t, { tagged: true });
  await ingest(scriptedAnalyst());
  const before = records.readRecord(dataDir, FIXTURE_FOLDER);
  const chapter = path.join(dataDir, 'workbooks', before.workbookId, 'content', bridge.INTERVIEW_CHAPTER_FILE);
  const chapterBefore = fs.readFileSync(chapter, 'utf8');
  const progressBefore = bridge.readProgress(dataDir, before.workbookId);
  fs.appendFileSync(path.join(dir, 'debrief.md'), '\nEdited while analyst is unavailable.\n');
  let calls = 0;
  const runAgentFn = async () => { calls++; return { ok: false, code: 17 }; };
  for (const attempt of [1, 2]) {
    const result = await ingest({ runAgentFn });
    const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
    assert.equal(result.status, 'ingested');
    assert.equal(rec.status, 'ingested');
    assert.deepEqual(rec.analysis, before.analysis);
    assert.equal(rec.workbookId, before.workbookId);
    assert.deepEqual(rec.effects, before.effects);
    assert.match(rec.analysisError, /exited with code 17/);
    assert.equal(rec.analysisAttempts, attempt);
    assert.equal(calls, attempt * 2);
    assert.match(result.summary, /debrief analysis failed/);
    assert.equal(fs.readFileSync(chapter, 'utf8'), chapterBefore);
    assert.deepEqual(bridge.readProgress(dataDir, before.workbookId), progressBefore);
    rebuildInterviewChapter(dataDir, before.workbookId);
    assert.equal(fs.readFileSync(chapter, 'utf8'), chapterBefore);
  }
  assert.equal((await ingest({ runAgentFn })).status, 'unchanged');
  assert.equal(calls, 4);
  // A later edit permits a new attempt, and a successful result clears the error.
  fs.appendFileSync(path.join(dir, 'debrief.md'), '\nAnalyst available again.\n');
  await ingest(scriptedAnalyst());
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).analysisError, null);
});

for (const folderKind of ['name', 'absolute', 'trailing slash', 'trailing dot']) {
  test(`ingest refuses a symlink session folder by ${folderKind}`, async (t) => {
    const { dataDir, interviewHome, dir } = setup(t, { tagged: true });
    const alias = path.join(interviewHome, 'sessions', 'session-alias');
    fs.symlinkSync(dir, alias);
    let calls = 0;
    const folder = folderKind === 'name' ? path.basename(alias)
      : folderKind === 'trailing slash' ? `${alias}/` : folderKind === 'trailing dot' ? `${alias}/.` : alias;
    await assert.rejects(ingestSession({ dataDir, interviewHome,
      folder,
      runAgentFn: async () => { calls++; throw new Error('must not run'); },
    }), (error) => error.code === 'INPUT' && /symlink/i.test(error.message));
    assert.equal(calls, 0);
    assert.equal(records.readRecord(dataDir, 'session-alias'), null);
  });
}

for (const action of ['write', 'remove']) {
  for (const failure of ['null', 'throw']) {
    test(`chapter ${action} skips metadata bump and logs once when readMeta returns ${failure}`, async (t) => {
      const { dataDir, ingest } = setup(t, { tagged: true });
      await ingest(scriptedAnalyst());
      const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
      const store = require('../lib/workbook/store');
      if (action === 'remove') records.writeRecord(dataDir, { ...rec, status: 'unlinked' });
      t.mock.method(store, 'readMeta', () => {
        if (failure === 'throw') throw new Error('unreadable\nmeta');
        return null;
      });
      const writer = t.mock.method(store, 'writeMeta', () => { throw new Error('must not bump'); });
      const lines = [];
      t.mock.method(console, 'warn', (line) => lines.push(line));
      assert.doesNotThrow(() => rebuildInterviewChapter(dataDir, rec.workbookId));
      assert.equal(writer.mock.calls.length, 0);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes(rec.workbookId));
      assert.match(lines[0], /metadata/i);
      assert.doesNotMatch(lines[0], /[\r\n]/);
      const chapter = path.join(dataDir, 'workbooks', rec.workbookId, 'content', bridge.INTERVIEW_CHAPTER_FILE);
      assert.equal(fs.existsSync(chapter), action === 'write');
    });
  }
}

test('first grade timestamps use startedAt even if an unlinked session was edited before linking', async (t) => {
  const { dir, ingest } = setup(t);
  await ingest();
  setSessionFields(dir, { roleKey: ROLE_KEY });
  const r = await ingest();
  assert.ok(r.effects.progress.every((g) => g.at === '2026-03-14T14:30:00.000Z'));
});

test('a workbook creation failure preserves analysis for the retry', async (t) => {
  const { dataDir, ingest, work } = setup(t, { tagged: true });
  const mocked = t.mock.method(bridge, 'ensureWorkbook', () => { throw new Error('workbook write failed'); });
  await assert.rejects(ingest(), /workbook write failed/);
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  assert.ok(rec && rec.status !== 'ingested');
  assert.equal(rec.analysis.asked.length, 2);
  mocked.mock.restore();
  assert.equal((await ingest()).status, 'ingested');
  assert.equal(fakeCalls(work)['debrief-analyst'], 1);
});


test('successful direct ingest clears lastError and unchanged retries leave the record alone', async (t) => {
  const { dataDir, ingest } = setup(t, { tagged: true });
  await ingest();
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  records.writeRecord(dataDir, { ...rec, lastError: 'old route failure' });
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).lastError, null);
  const writer = t.mock.method(records, 'writeRecord');
  assert.equal((await ingest()).status, 'unchanged');
  assert.equal(writer.mock.calls.length, 0);
});

test('scanner recovery clears lastError inside ingest', async (t) => {
  const { dataDir, interviewHome, ingest } = setup(t, { tagged: true });
  await ingest();
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  records.writeRecord(dataDir, { ...rec, status: 'failed', applied: false, lastError: 'old route failure' });
  const result = await require('../lib/interview/scanner').scanOnce({ dataDir, interviewHome, now });
  assert.deepEqual(result, [{ folder: FIXTURE_FOLDER, status: 'ingested' }]);
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).lastError, null);
});

test('removing an empty interview chapter bumps workbook updatedAt', async (t) => {
  const { dataDir, ingest } = setup(t, { tagged: true });
  await ingest();
  const wb = bridge.findWorkbook(dataDir, ROLE_KEY);
  const metaFile = path.join(wb.dir, 'meta.json');
  const oldDate = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(metaFile, JSON.stringify({ ...readJson(metaFile), updatedAt: oldDate }));
  const rec = records.readRecord(dataDir, FIXTURE_FOLDER);
  records.writeRecord(dataDir, { ...rec, status: 'unlinked' });
  rebuildInterviewChapter(dataDir, wb.id);
  assert.equal(fs.existsSync(path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)), false);
  assert.ok(readJson(metaFile).updatedAt > oldDate);
});


test('successful unlinked retry clears a stale lastError once', async (t) => {
  const { dataDir, ingest } = setup(t);
  await ingest();
  records.writeRecord(dataDir, { ...records.readRecord(dataDir, FIXTURE_FOLDER), lastError: 'old route failure' });
  assert.equal((await ingest()).status, 'unlinked');
  assert.equal(records.readRecord(dataDir, FIXTURE_FOLDER).lastError, null);
  const writer = t.mock.method(records, 'writeRecord');
  assert.equal((await ingest()).status, 'unlinked');
  assert.equal(writer.mock.calls.length, 0);
});


test('a fixture-free session predating question tracking stays unlinked until its debrief is analyzed', async (t) => {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  seedRole(env.dataDir);
  const folder = '2025-01-02_0900';
  const dir = path.join(env.interviewHome, 'sessions', folder);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    round: 'coding', started_at: 1735826400, phase_history: [], stages: {}, summary: '', clip: '',
  }));
  const question = 'How would you reverse a linked list?';
  fs.writeFileSync(path.join(dir, 'debrief.md'), `# Debrief\n\nAsked: ${question}\n`);
  let calls = 0;
  const runAgentFn = async ({ cwd, prompt }) => {
    calls++;
    assert.ok(prompt.includes(question));
    fs.writeFileSync(path.join(cwd, 'analysis.json'), JSON.stringify({
      asked: [{ title: 'Reverse a linked list', prompt: question, type: 'code', topic: 'Coding', diff: 2,
        rubric: 'Preserve the next node before reversing each link.', answer: 'Walk the list with previous and next pointers.',
        grade: 'got', evidence: 'Explained pointer updates.' }], weakSpots: [], followUps: [],
    }));
    return { ok: true };
  };
  const args = { ...env, folder, now, runAgentFn };
  assert.equal((await ingestSession(args)).status, 'unlinked');
  assert.deepEqual(records.readRecord(env.dataDir, folder).questions, []);
  assert.equal(records.readRecord(env.dataDir, folder).contractVersion, null);
  assert.equal(calls, 0);
  assert.equal((await linkSession({ ...args, roleKey: ROLE_KEY })).status, 'ingested');
  assert.equal(records.readRecord(env.dataDir, folder).analysis.asked[0].prompt, question);
  assert.equal(calls, 1);
});
