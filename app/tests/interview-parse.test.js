// app/tests/interview-parse.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSessionFolder, extractSection } = require('../lib/interview/session-parse');
const { InputError } = require('../lib/interview/contract');
const { makeEnv, copyFixtureSession, setSessionFields, FIXTURE_FOLDER } = require('./helpers/interview-env');

function fixture() {
  const { interviewHome } = makeEnv();
  return copyFixtureSession(interviewHome);
}

test('endedAt zero is a valid end in epoch seconds and overrides the debrief', () => {
  const dir = fixture();
  setSessionFields(dir, {
    started_at: -120.5, endedAt: 0,
    phase_history: [{ phase: 'code', start: -120.5, end: null }],
  });
  const p = parseSessionFolder(dir);
  assert.equal(p.startedAt, '1969-12-31T23:57:59.500Z');
  assert.equal(p.durationMin, 2);
  assert.deepEqual(p.phases, [{ phase: 'code', minutes: 2 }]);
});

test('missing started_at is malformed instead of deriving a start from the folder or current time', () => {
  const dir = fixture();
  setSessionFields(dir, {
    started_at: undefined, endedAt: undefined,
    phase_history: [{ phase: 'code', start: 120, end: null }],
  });
  fs.rmSync(path.join(dir, 'debrief.md'));
  for (const contractVersion of ['jq-interview/1', undefined]) {
    setSessionFields(dir, { contractVersion });
    assert.throws(() => parseSessionFolder(dir), (e) => e instanceof InputError
      && e.code === 'INPUT' && e.message === `${FIXTURE_FOLDER}: session.json needs a numeric "started_at"`);
  }
});

for (const startedAtJson of ['null', '"1773498600"', 'false', '1e400', '-1e400']) {
  test(`started_at rejects ${startedAtJson} in current and legacy sessions`, () => {
    const dir = fixture();
    for (const contractVersion of ['jq-interview/1', undefined]) {
      const sess = setSessionFields(dir, { contractVersion, started_at: undefined });
      fs.writeFileSync(path.join(dir, 'session.json'),
        JSON.stringify(sess).replace(/}$/, `,"started_at":${startedAtJson}}`));
      assert.throws(() => parseSessionFolder(dir), (e) => e instanceof InputError
        && e.code === 'INPUT' && e.message === `${FIXTURE_FOLDER}: session.json needs a numeric "started_at"`);
    }
  });
}

test('parses an interviewer first name with Unicode letters', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'debrief.md'), '## Scorecard\n\nInterviewer: Élodie, platform team.\n');
  assert.equal(parseSessionFolder(dir).interviewer, 'Élodie');
});

test('section extraction preserves subheadings and stops at the next level-two heading', () => {
  assert.equal(extractSection('## Scorecard\n\nNotes\n### Details\nKeep this\n## Follow-up\nOther', 'Scorecard'),
    'Notes\n### Details\nKeep this');
  assert.equal(extractSection('## Scorecard\n_none recorded_\n', 'Scorecard'), '');
  assert.equal(extractSection('', 'Scorecard'), '');
});

test('parses the shared fixture', () => {
  const p = parseSessionFolder(fixture());
  assert.equal(p.folder, FIXTURE_FOLDER);
  assert.equal(p.legacy, false);
  assert.equal(p.contractVersion, 'jq-interview/1');
  assert.equal(p.roleKey, null);
  assert.equal(p.round, 'coding');
  assert.equal(p.practice, false);
  assert.equal(p.startedAt, '2026-03-14T14:30:00.000Z');
  assert.equal(p.durationMin, 45);
  assert.equal(p.interviewer, 'Alex');
  assert.deepEqual(p.questions, [
    { id: 1, title: 'Rate limiter: sliding window', ts: '2026-03-14T14:31:00Z' },
    { id: 2, title: 'Merge overlapping intervals', ts: '2026-03-14T14:50:00Z' },
  ]);
  assert.deepEqual(p.phases, [
    { phase: 'clarify', minutes: 3 }, { phase: 'next', minutes: 2 }, { phase: 'code', minutes: 20 },
    { phase: 'solution', minutes: 5 }, { phase: 'test', minutes: 10 }, { phase: 'optimize', minutes: 5 },
  ]);
  assert.ok(p.scorecard.startsWith('Interviewer: Alex, platform team.'));
  assert.ok(p.scorecard.includes('### Prepare for the next round'));
  assert.equal(p.recruiterMemory, null);
});

test('a live question already archived is not listed twice', () => {
  const dir = fixture();
  setSessionFields(dir, { question: { id: 1, title: 'Rate limiter: sliding window', ts: '2026-03-14T14:31:00Z' } });
  assert.equal(parseSessionFolder(dir).questions.length, 1);
});

test('legacy sessions are read-only: roleKey ignored, end time taken from the debrief total', () => {
  const dir = fixture();
  setSessionFields(dir, { contractVersion: undefined, practiceSet: undefined, practiceResults: undefined, endedAt: undefined, roleKey: 'Acme Capital|Software Engineer' });
  const p = parseSessionFolder(dir);
  assert.equal(p.legacy, true);
  assert.equal(p.roleKey, null);
  assert.equal(p.practice, false);
  assert.equal(p.durationMin, 45);
  assert.deepEqual(p.phases.find((x) => x.phase === 'optimize'), { phase: 'optimize', minutes: 5 });
});

test('a different contract major is refused', () => {
  const dir = fixture();
  setSessionFields(dir, { contractVersion: 'jq-interview/2' });
  assert.throws(() => parseSessionFolder(dir), (e) => e.code === 'CONTRACT' && /jq-interview\/2/.test(e.message));
});

test('missing or malformed session.json is reported', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'session.json'), '{"round": "coding"}');
  assert.throws(() => parseSessionFolder(dir), (e) => e.code === 'INPUT' && /needs "round" and "questions"/.test(e.message));
  fs.writeFileSync(path.join(dir, 'session.json'), '{nope');
  assert.throws(() => parseSessionFolder(dir), (e) => e.code === 'INPUT');
  fs.rmSync(path.join(dir, 'session.json'));
  assert.throws(() => parseSessionFolder(dir), (e) => e.code === 'NOT_FOUND');
});

test('a skeleton debrief has no scorecard and no interviewer', () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'debrief.md'), '# Debrief\n\nRound: coding\n\nTotal session: 10:00.\n\n## Scorecard\n\n_(filled in by the /interview skill on stop)_\n');
  const p = parseSessionFolder(dir);
  assert.equal(p.scorecard, '');
  assert.equal(p.interviewer, null);
});

test('practice sessions carry their practice results', () => {
  const dir = fixture();
  setSessionFields(dir, { practiceSet: '/tmp/practice/acme.json', practiceResults: [{ qid: 'c1', grade: 'missed', note: '' }] });
  const p = parseSessionFolder(dir);
  assert.equal(p.practice, true);
  assert.deepEqual(p.practiceResults, [{ qid: 'c1', grade: 'missed', note: '' }]);
});

test('recruiter rounds expose the memory panel sections', () => {
  const dir = fixture();
  setSessionFields(dir, { round: 'recruiter' });
  fs.writeFileSync(path.join(dir, 'debrief.md'), [
    '# Debrief', '', 'Round: recruiter', '', '## About the role', '', 'Platform team, new headcount.', '',
    '## Facts they said', '', '- Two technical rounds', '- Decision within a week', '',
    '## Things they want to hear', '', '_none recorded_', '', '## Follow-up', '', 'Send the portfolio link.', '',
  ].join('\n'));
  const p = parseSessionFolder(dir);
  assert.deepEqual(p.recruiterMemory, {
    'About the role': 'Platform team, new headcount.',
    'Facts they said': '- Two technical rounds\n- Decision within a week',
  });
  assert.equal(extractSection(p.debrief, 'Follow-up'), 'Send the portfolio link.');
});
