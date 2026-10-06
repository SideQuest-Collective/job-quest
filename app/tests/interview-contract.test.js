// app/tests/interview-contract.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../lib/interview/contract');
const { FIXTURE_DIR, FIXTURE_FOLDER } = require('./helpers/interview-env');

function fixtureBannedMatcher(env = process.env) {
  const generic = /linkedin|github\.com\/|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/i;
  const privateTerms = (env.JQ_FIXTURE_BANNED_TERMS || '').split(',').map((term) => term.trim()).filter(Boolean);
  const patterns = privateTerms.map((term) => '\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  return new RegExp([generic.source, ...patterns].join('|'), 'i');
}

test('contractMajor reads the major of jq-interview/N', () => {
  assert.equal(c.contractMajor('jq-interview/1'), 1);
  assert.equal(c.contractMajor('jq-interview/2.3'), 2);
  assert.equal(c.contractMajor('other/1'), null);
  assert.equal(c.contractMajor(undefined), null);
});

test('assertContract accepts major 1 and refuses others with one line', () => {
  c.assertContract('jq-interview/1', 'x');
  assert.throws(() => c.assertContract('jq-interview/2', 'session 2026-10-01_0900'), (err) => {
    assert.ok(err instanceof c.ContractError);
    assert.equal(err.code, 'CONTRACT');
    assert.equal(err.message, 'contract mismatch: session 2026-10-01_0900 uses jq-interview/2; Job Quest supports jq-interview/1');
    return true;
  });
});

test('assertFolderName rejects traversal and separators', () => {
  assert.equal(c.assertFolderName('2026-03-14_0930'), '2026-03-14_0930');
  for (const bad of ['..', '../etc', 'a/b', '/abs', '', '.hidden', 'a\\b', 'a..b']) {
    assert.throws(() => c.assertFolderName(bad), (e) => e.code === 'INPUT', bad);
  }
});

test('homes honour INTERVIEW_HOME, JOB_QUEST_HOME, DATA_DIR', () => {
  assert.equal(c.interviewHome({ INTERVIEW_HOME: '/tmp/iv' }), '/tmp/iv');
  assert.equal(c.interviewHome({}), path.join(os.homedir(), '.interview'));
  assert.equal(c.jobQuestHome({ JOB_QUEST_HOME: '/tmp/jq' }), '/tmp/jq');
  assert.equal(c.dataDirFromEnv({ DATA_DIR: '/tmp/d' }), '/tmp/d');
  assert.equal(c.dataDirFromEnv({ JOB_QUEST_HOME: '/tmp/jq' }), '/tmp/jq/data');
});

test('interviewInstalled checks for app/capture.py', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-iv-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(c.interviewInstalled(home), false);
  fs.mkdirSync(path.join(home, 'app'));
  fs.writeFileSync(path.join(home, 'app', 'capture.py'), '');
  assert.equal(c.interviewInstalled(home), true);
});

test('shared fixture carries the contract fields', () => {
  const sess = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, FIXTURE_FOLDER, 'session.json'), 'utf-8'));
  assert.equal(sess.contractVersion, 'jq-interview/1');
  assert.equal(sess.roleKey, null);
  assert.equal(sess.practiceSet, null);
  assert.deepEqual(sess.practiceResults, []);
  assert.equal(sess.round, 'coding');
  assert.equal(sess.questions.length, 1);
  assert.equal(sess.question.id, 2);
});

test('shared fixture is a fully synthetic 45-minute coding session', () => {
  assert.equal(FIXTURE_FOLDER, '2026-03-14_0930');
  const dir = path.join(FIXTURE_DIR, FIXTURE_FOLDER);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'debrief.md', 'session.json', 'stages.md', 'transcript.jsonl', 'transcript.md',
  ]);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf-8'));
  assert.deepEqual(Object.keys(sess).sort(), [
    'cheatsheet', 'clip', 'contractVersion', 'endedAt', 'now', 'phase', 'phase_history',
    'practiceQuestions', 'practiceResults', 'practiceSet', 'question', 'questions',
    'revisit', 'roleKey', 'round', 'stages', 'started_at', 'summary',
  ].sort());
  assert.equal(new Date(sess.started_at * 1000).toISOString(), '2026-03-14T14:30:00.000Z');
  assert.equal(sess.endedAt - sess.started_at, 45 * 60);
  assert.deepEqual([...sess.questions, sess.question].map((q) => q.title), [
    'Rate limiter: sliding window', 'Merge overlapping intervals',
  ]);
  const debrief = fs.readFileSync(path.join(dir, 'debrief.md'), 'utf-8');
  assert.match(debrief, /Total session: 45:00\. Interviewer utterances: 40\. Your utterances: 60\. Clipboard captures: 4\. Hints given: 2\./);
  assert.match(debrief, /## Scorecard\n\nInterviewer: Alex, platform team\./);
  assert.match(debrief, /Clarify whether touching intervals should merge before writing the comparison\./);
  const transcript = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse);
  assert.equal(transcript[0].ts, '2026-03-14T14:30:00Z');
  assert.equal(transcript.at(-1).ts, '2026-03-14T15:15:00Z');
  assert.ok(transcript.some((line) => line.text === 'I will sort by start time and extend the last interval when the ranges overlap.'));
});

test('fixture matcher detects runtime banned terms as escaped whole words', (t) => {
  const previous = process.env.JQ_FIXTURE_BANNED_TERMS;
  t.after(() => {
    if (previous === undefined) delete process.env.JQ_FIXTURE_BANNED_TERMS;
    else process.env.JQ_FIXTURE_BANNED_TERMS = previous;
  });
  delete process.env.JQ_FIXTURE_BANNED_TERMS;
  assert.equal(fixtureBannedMatcher().test('fixturetoken private.term'), false);

  process.env.JQ_FIXTURE_BANNED_TERMS = ' fixturetoken, , private.term ';
  const banned = fixtureBannedMatcher();
  assert.equal(banned.test('contains FIXTURETOKEN here'), true);
  assert.equal(banned.test('contains PRIVATE.TERM here'), true);
  assert.equal(banned.test('prefixturetoken fixturetokens'), false);
  assert.equal(banned.test('privateXterm'), false);
  assert.equal(banned.test('ordinary fixture text'), false);
});

test('shared fixture is sanitized: no real names, employers, or contact details', () => {
  const banned = fixtureBannedMatcher();
  const dir = path.join(FIXTURE_DIR, FIXTURE_FOLDER);
  for (const f of fs.readdirSync(dir)) {
    const hit = fs.readFileSync(path.join(dir, f), 'utf-8').match(banned);
    assert.equal(hit, null, `${f} contains "${hit && hit[0]}"`);
  }
});

test('CONTRACT.md names the contract and the exact marker', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '..', '..', 'CONTRACT.md'), 'utf-8');
  assert.match(text, /^# Contract `jq-interview\/1`/);
  assert.ok(text.includes(c.MARKER_MD));
});
