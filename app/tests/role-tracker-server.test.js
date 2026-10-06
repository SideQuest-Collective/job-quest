const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withServer, post } = require('./helpers/server');
const { makeEnv, seedTracker, readJson } = require('./helpers/interview-env');

const noteBlock = folder => `[interview:${folder}] Recruiter call 2026-03-14\nTeam: Platform\n[/interview:${folder}]`;
const interview = { key: 'interview:2026-03-14_0930', date: '2026-03-14T14:30:00.000Z', event: 'Recruiter call', custom: { keep: true } };

function snapshots() {
  const manual = { date: '2026-03-15', event: 'User follow-up' };
  const editedInterview = { key: 'interview:older', date: '2026-03-13', event: 'User correction' };
  const disk = {
    'Acme|SWE': { stage: 'onsite', notes: `Old notes\n\n${noteBlock('older')}\n\n${noteBlock('2026-03-14_0930')}`, timeline: [{ ...editedInterview, event: 'Old event' }, interview, { date: '2026-03-16', event: 'Deleted manual event' }], checklist: ['old'], diskOnly: true },
    'Ingested|SWE': { stage: 'applied', notes: 'Created during ingest', timeline: [interview] },
    'Deleted|SWE': { stage: 'saved', notes: 'User deleted this', timeline: [manual] },
    'Notes only|SWE': { stage: 'saved', notes: noteBlock('notes-only'), timeline: [] },
  };
  const body = {
    'Acme|SWE': { stage: 'applied', notes: `New user notes\n\n${noteBlock('older').replace('Platform', 'Updated')}`, timeline: [editedInterview, manual], checklist: ['new'], bodyOnly: 42 },
  };
  const merged = {
    'Acme|SWE': { ...body['Acme|SWE'], notes: `${body['Acme|SWE'].notes}\n\n${noteBlock('2026-03-14_0930')}`, timeline: [editedInterview, interview, manual] },
    'Ingested|SWE': disk['Ingested|SWE'],
  };
  return { disk, body, merged };
}

test('stale dashboard POST preserves interview data and roles while applying user edits and deletions', async (t) => {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const { disk, body, merged } = snapshots();
  seedTracker(env.dataDir, disk);
  await withServer(env.dataDir, async base => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/role-tracker`, post(body));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true });
      assert.deepEqual(await (await fetch(`${base}/api/role-tracker`)).json(), merged);
      assert.deepEqual(readJson(path.join(env.dataDir, 'role-tracker.json')), merged);
    }
    const events = Object.values(readJson(path.join(env.dataDir, 'activity.json'))).flatMap(day => day.events);
    assert.deepEqual(events.map(({ type, detail }) => ({ type, detail })), [
      { type: 'role_stage_change', detail: { role: 'Acme|SWE', from: 'onsite', to: 'applied' } },
    ]);
  }, { HOME: env.root, INTERVIEW_HOME: env.interviewHome });
});

test('dashboard POST rejects non-object tracker bodies with JSON errors and preserves disk bytes', async (t) => {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  seedTracker(env.dataDir, snapshots().disk);
  const file = path.join(env.dataDir, 'role-tracker.json');
  const before = fs.readFileSync(file, 'utf8');
  await withServer(env.dataDir, async base => {
    for (const body of [[], [1, 2], null, 'tracker', 42, true]) {
      await t.test(`rejects ${JSON.stringify(body)}`, async () => {
        const response = await fetch(`${base}/api/role-tracker`, post(body));
        assert.equal(response.status, 400);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.equal(typeof (await response.json()).error, 'string');
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        assert.equal(fs.existsSync(path.join(env.dataDir, 'activity.json')), false);
      });
    }
  }, { HOME: env.root, INTERVIEW_HOME: env.interviewHome });
});

test('dashboard POST rejects invalid tracker bodies before reading or writing tracker data', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/role-tracker'"), source.indexOf('// --- Evaluate Practice Answer ---'));
  let handler;
  const unexpected = () => assert.fail('invalid tracker body must not touch stored data');
  vm.runInNewContext(route, {
    app: { post: (_url, fn) => { handler = fn; } }, DATA_DIR: '/unused',
    readTracker: unexpected, writeTracker: unexpected, mergeTrackerSnapshot: unexpected,
    logActivity: unexpected, diffTracker: unexpected, roleEvents: { emit: unexpected },
  });
  for (const body of [undefined, null, [], [1, 2], 'tracker', 42, true]) {
    let status, response;
    handler({ body }, {
      status(code) { status = code; return this; },
      json(value) { response = value; },
    });
    assert.equal(status, 400);
    assert.equal(typeof response.error, 'string');
  }
});

test('dashboard POST atomically publishes the merged tracker and passes it to activity and role events', (t) => {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  const { disk, body, merged } = snapshots();
  seedTracker(env.dataDir, disk);
  const file = path.join(env.dataDir, 'role-tracker.json');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const route = source.slice(source.indexOf("app.post('/api/role-tracker'"), source.indexOf('// --- Evaluate Practice Answer ---'));
  const rename = fs.renameSync;
  const temps = [], events = [], activities = [];
  let handler, previous = disk;
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.equal(to, file);
    assert.equal(path.dirname(from), env.dataDir);
    assert.ok(from.endsWith('.tmp'));
    assert.notEqual(from, `${file}.tmp`);
    assert.deepEqual(readJson(file), previous, 'live tracker is untouched until rename');
    assert.deepEqual(readJson(from), merged);
    temps.push(from);
    rename(from, to);
  });
  vm.runInNewContext(route, {
    app: { post: (_url, fn) => { handler = fn; } }, fs, path, DATA_DIR: env.dataDir,
    ...require('../lib/interview/tracker-effects'),
    diffTracker: (prev, next) => {
      assert.deepEqual(JSON.parse(JSON.stringify(next)), merged);
      return require('../lib/jobs/role-events').diffTracker(prev, next);
    },
    logActivity: (type, detail) => {
      assert.deepEqual(readJson(file), merged);
      activities.push({ type, detail: JSON.parse(JSON.stringify(detail)) });
    },
    roleEvents: { emit: (...args) => events.push(args) },
  });
  for (let i = 0; i < 2; i++) {
    handler({ body: structuredClone(body) }, { json: () => {} });
    previous = merged;
  }
  assert.equal(new Set(temps).size, 2, 'each save uses a unique sibling temp');
  assert.deepEqual(events, [['applied', 'Acme|SWE']]);
  assert.deepEqual(activities, [{ type: 'role_stage_change', detail: { role: 'Acme|SWE', from: 'onsite', to: 'applied' } }]);
  assert.deepEqual(fs.readdirSync(env.dataDir), ['role-tracker.json']);
});
