// app/tests/interview-tracker.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('../lib/interview/tracker-effects');
const { makeEnv } = require('./helpers/interview-env');

const entry = (stage, timeline = []) => ({ stage, notes: '', checklist: [], timeline });

test('timelineEvent follows "<Round> round[ with <interviewer>], <N> min[, practice]"', () => {
  assert.equal(fx.timelineEvent({ round: 'coding', interviewer: 'Alex', durationMin: 45, practice: false }), 'Coding round with Alex, 45 min');
  assert.equal(fx.timelineEvent({ round: 'system', interviewer: null, durationMin: 45, practice: true }), 'System design round, 45 min, practice');
  assert.equal(fx.timelineEvent({ round: 'recruiter', interviewer: 'Kim', durationMin: 20, practice: false }), 'Recruiter round with Kim, 20 min');
});

test('upsertTimeline adds once by key, updates text, and inserts by date without reordering', () => {
  const e = entry('applied', [{ date: '2026-03-23T00:00:00.000Z', event: 'later' }, { date: '2026-03-01T00:00:00.000Z', event: 'unsorted earlier' }]);
  assert.equal(fx.upsertTimeline(e, { key: 'interview:f', date: '2026-03-14T14:30:00.000Z', event: 'Coding round, 45 min' }), 'added');
  assert.deepEqual(e.timeline.map((t) => t.event), ['Coding round, 45 min', 'later', 'unsorted earlier']);
  assert.equal(fx.upsertTimeline(e, { key: 'interview:f', date: '2026-03-14T14:30:00.000Z', event: 'Coding round, 45 min' }), 'same');
  assert.equal(fx.upsertTimeline(e, { key: 'interview:f', date: '2026-03-14T14:30:00.000Z', event: 'Coding round with Alex, 45 min' }), 'updated');
  assert.equal(e.timeline.filter((t) => t.key === 'interview:f').length, 1);
  assert.equal(fx.removeTimeline(e, 'interview:f'), true);
  assert.equal(fx.removeTimeline(e, 'interview:f'), false);
  assert.equal(e.timeline.length, 2);
});

test('stage ladder raises only, never lowers', () => {
  const e = entry('applied');
  assert.deepEqual(fx.applyStage(e, 'recruiter', false), { from: 'applied', to: 'phone-screen' });
  assert.equal(fx.applyStage(e, 'screen', false), null);
  assert.equal(e.stage, 'phone-screen');
  assert.deepEqual(fx.applyStage(e, 'coding', false), { from: 'phone-screen', to: 'onsite' });
  assert.equal(fx.applyStage(e, 'recruiter', false), null);
  assert.equal(e.stage, 'onsite');
  assert.deepEqual(fx.applyStage(entry('researching'), 'behavioral', false), { from: 'researching', to: 'onsite' });
});

test('practice sessions never change the stage; off-ladder stages are untouched', () => {
  const p = entry('applied');
  assert.equal(fx.applyStage(p, 'coding', true), null);
  assert.equal(p.stage, 'applied');
  for (const s of ['offer', 'rejected', 'custom-stage']) {
    const e = entry(s);
    assert.equal(fx.applyStage(e, 'system', false), null);
    assert.equal(e.stage, s);
  }
  assert.equal(fx.applyStage(entry('applied'), 'lunch', false), null);
});

test('ensureEntry creates a minimal tracker entry once', () => {
  const t = {};
  const e = fx.ensureEntry(t, 'Acme|SWE');
  assert.deepEqual(e, { stage: 'discovered', notes: '', checklist: [], timeline: [] });
  e.notes = 'kept';
  assert.equal(fx.ensureEntry(t, 'Acme|SWE').notes, 'kept');
});

test('recruiter memory is appended under a dated heading and replaced, not duplicated', () => {
  const e = { ...entry('applied'), notes: 'My own notes.' };
  const memory = { 'About the role': 'Platform team.', 'Facts they said': '- Two rounds' };
  assert.equal(fx.upsertRecruiterNotes(e, '2026-09-14_1030', '2026-09-14', memory), true);
  assert.equal(e.notes, 'My own notes.\n\n[interview:2026-09-14_1030] Recruiter call 2026-09-14\nAbout the role:\nPlatform team.\nFacts they said:\n- Two rounds\n[/interview:2026-09-14_1030]');
  assert.equal(fx.upsertRecruiterNotes(e, '2026-09-14_1030', '2026-09-14', memory), false);
  fx.upsertRecruiterNotes(e, '2026-09-14_1030', '2026-09-14', { ...memory, 'Facts they said': '- Three rounds' });
  assert.equal(e.notes.match(/\[interview:2026-09-14_1030\]/g).length, 1);
  assert.ok(e.notes.includes('- Three rounds'));
  assert.ok(e.notes.startsWith('My own notes.'));
});

test('readTracker/writeTracker round-trip; a missing file reads as {}', (t) => {
  const { dataDir } = tempEnv(t);
  assert.deepEqual(fx.readTracker(dataDir), {});
  fx.writeTracker(dataDir, { 'Acme|SWE': entry('applied') });
  assert.equal(fx.readTracker(dataDir)['Acme|SWE'].stage, 'applied');
});

function tempEnv(t) {
  const env = makeEnv();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  return env;
}

test('mixed date-only and ISO dates insert in code-unit order and retain existing order', () => {
  const first = { date: '2026-03-14', event: 'Date-only' };
  const last = { date: '2026-03-15', event: 'Next day' };
  const e = entry('applied', [first, last]);
  fx.upsertTimeline(e, { key: 'interview:noon', date: '2026-03-14T12:00:00.000Z', event: 'Noon' });
  fx.upsertTimeline(e, { key: 'interview:midnight', date: '2026-03-14T00:00:00.000Z', event: 'Midnight' });
  fx.upsertTimeline(e, { key: 'interview:earlier', date: '2026-03-13T23:59:59.999Z', event: 'Earlier' });
  assert.deepEqual(e.timeline.map((item) => item.event), ['Earlier', 'Date-only', 'Midnight', 'Noon', 'Next day']);
  assert.equal(e.timeline[1], first);
  assert.equal(e.timeline[4], last);
  assert.equal(first.date, '2026-03-14');
});

test('read-modify-write preserves unknown top-level, role, and timeline fields', (t) => {
  const { dataDir } = tempEnv(t);
  const original = {
    _settings: { custom: [false, null, '雪'] },
    'Other|Role': { untouched: true },
    'Acme|SWE': {
      ...entry('applied', [
        { key: 'interview:f', date: '2026-03-14T00:00:00.000Z', event: 'Old', custom: { nested: [1, 2] } },
        { date: '2026-03-15', event: 'Manual', extra: true },
      ]),
      url: 'https://example.com/job', custom: { salary: 100, tags: ['a'] },
      checklist: [{ text: 'Keep', done: false, extra: 'yes' }],
    },
  };
  fs.writeFileSync(path.join(dataDir, 'role-tracker.json'), JSON.stringify(original));
  const tracker = fx.readTracker(dataDir);
  const e = fx.ensureEntry(tracker, 'Acme|SWE');
  assert.equal(e, tracker['Acme|SWE']);
  assert.equal(fx.upsertTimeline(e, { key: 'interview:f', date: '2026-03-14T14:30:00.000Z', event: 'New' }), 'updated');
  fx.applyStage(e, 'coding', false);
  fx.writeTracker(dataDir, tracker);
  original['Acme|SWE'].stage = 'onsite';
  original['Acme|SWE'].timeline[0].date = '2026-03-14T14:30:00.000Z';
  original['Acme|SWE'].timeline[0].event = 'New';
  assert.deepEqual(fx.readTracker(dataDir), original);
});

test('writeTracker publishes via distinct sibling temp files and rename', (t) => {
  const { dataDir } = tempEnv(t);
  const file = path.join(dataDir, 'role-tracker.json');
  const rename = fs.renameSync;
  const temps = [];
  let previous = { old: true };
  fs.writeFileSync(file, JSON.stringify(previous));
  t.mock.method(fs, 'renameSync', (source, dest) => {
    assert.equal(dest, file);
    assert.equal(path.dirname(source), dataDir);
    assert.notEqual(source, `${file}.tmp`);
    assert.ok(source.endsWith('.tmp'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), previous);
    temps.push(source);
    rename(source, dest);
  });
  fx.writeTracker(dataDir, { next: 1 });
  previous = { next: 1 };
  fx.writeTracker(dataDir, { next: 2 });
  assert.equal(new Set(temps).size, 2);
  assert.deepEqual(fx.readTracker(dataDir), { next: 2 });
  assert.deepEqual(fs.readdirSync(dataDir), ['role-tracker.json']);
});

test('writeTracker cleans temporary files on write or rename failure and keeps live data', (t) => {
  const { dataDir } = tempEnv(t);
  const file = path.join(dataDir, 'role-tracker.json');
  const original = '{"keep": {"exact": true}}\n';
  fs.writeFileSync(file, original);
  const failure = new Error('injected IO failure');
  const renameMock = t.mock.method(fs, 'renameSync', () => { throw failure; });
  assert.throws(() => fx.writeTracker(dataDir, { replaced: true }), (error) => error === failure);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dataDir), ['role-tracker.json']);
  renameMock.mock.restore();
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (dest) => {
    write(dest, 'partial');
    throw failure;
  });
  assert.throws(() => fx.writeTracker(dataDir, { replaced: true }), (error) => error === failure);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dataDir), ['role-tracker.json']);
});

test('readTracker propagates corrupt JSON and IO failures instead of losing live fields', (t) => {
  const { dataDir } = tempEnv(t);
  fs.writeFileSync(path.join(dataDir, 'role-tracker.json'), '{');
  assert.throws(() => fx.readTracker(dataDir), SyntaxError);
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readFileSync', () => { throw denied; });
  assert.throws(() => fx.readTracker(dataDir), (error) => error === denied);
});

test('all mapped stages only advance and unknown rounds never change a stage', () => {
  assert.deepEqual(fx.ROUND_RANK, { recruiter: 1, screen: 2, coding: 3, system: 3, behavioral: 3 });
  assert.deepEqual(fx.STAGE_RANK, { discovered: 0, researching: 0, saved: 0, applied: 0, 'phone-screen': 2, onsite: 3 });
  for (const [stage, rank] of Object.entries(fx.STAGE_RANK)) {
    for (const [round, want] of Object.entries(fx.ROUND_RANK)) {
      const e = entry(stage);
      const next = want === 3 ? 'onsite' : 'phone-screen';
      assert.deepEqual(fx.applyStage(e, round, false), want > rank ? { from: stage, to: next } : null);
      assert.equal(e.stage, want > rank ? next : stage);
      const p = entry(stage);
      assert.equal(fx.applyStage(p, round, true), null);
      assert.equal(p.stage, stage);
    }
  }
  for (const round of ['lunch', 'constructor', 'toString', '__proto__']) {
    const e = entry('applied');
    assert.equal(fx.applyStage(e, round, false), null);
    assert.equal(e.stage, 'applied');
  }
});

test('recruiter note replacement preserves surrounding text and other session blocks', () => {
  const e = entry('applied');
  e.notes = 'My notes.';
  fx.upsertRecruiterNotes(e, 'f.one', '2026-09-14', { Facts: 'Old' });
  fx.upsertRecruiterNotes(e, 'fXone', '2026-09-15', { Facts: 'Keep $& literally' });
  e.notes += '\n\nMy trailing notes.  ';
  const before = e.notes;
  assert.equal(fx.upsertRecruiterNotes(e, 'f.one', '2026-09-14', { Facts: 'New $& literally' }), true);
  assert.equal(e.notes, before.replace('Facts:\nOld', () => 'Facts:\nNew $& literally'));
  assert.equal(fx.upsertRecruiterNotes(e, 'f.one', '2026-09-14', { Facts: 'New $& literally' }), false);
});
