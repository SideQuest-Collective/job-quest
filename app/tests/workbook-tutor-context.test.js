const test = require('node:test');
const assert = require('node:assert/strict');
const tutor = require('../lib/workbook/tutor');

function idle() {
  return { revision: 0, phase: 'idle', messages: [], skills: [], focusId: null,
    targetLevel: 4, diagnosticCount: 0, learningTurns: 0, lastReviewTurn: 0,
    reviewDue: false, evidence: {}, final: {}, requests: {} };
}
function diagnostic(id, extra = {}) {
  return { phase: 'diagnostic', message: '', question: 'When does initialization happen?',
    skills: [{ id, title: 'Constructor behavior', level: 0 }], focusId: id, ...extra };
}

test('a valid constructor skill can persist diagnostic answer evidence just like another skill', () => {
  for (const id of ['initialization', 'constructor']) {
    const start = tutor.advance(idle(), diagnostic(id), 'Teach me object initialization');
    const prior = start.messages.at(-1);
    const next = tutor.advance(start, diagnostic(id, {
      evaluation: { questionId: prior.questionId, skillId: id, correct: true, kind: 'diagnostic' },
    }), 'The constructor runs when an instance is created.');
    assert.equal(next.revision, 2);
    assert.equal(next.evidence[id].length, 1);
    assert.equal(next.evidence[id][0].questionId, prior.questionId);
  }
});

test('a large existing workbook keeps the focused later topic and its exercise in tutor context', () => {
  const chapters = Array.from({ length: 24 }, (_, i) => ({
    id: `topic-${i}`, title: `Earlier topic ${i}`, topic: `topic-${i}`,
    body: 'A cache stores a value for reuse; expiration and invalidation need separate reasoning. '.repeat(65),
  }));
  chapters.push({ id: 'cache-fencing', title: 'Cache fencing', topic: 'cache-fencing',
    body: 'Storage rejects stale writes by comparing a monotonically increasing fence token.' });
  const exercise = 'When does the cache fence prevent a stale writer from committing?';
  const content = { chapters, questions: [{ id: 'fence-1', chapter: 'cache-fencing',
    topic: 'cache-fencing', type: 'open', body: exercise,
    answer: 'The storage layer rejects the write when its fencing token is older than the last accepted token.' }], glossary: [] };
  const state = { ...idle(), revision: 5, phase: 'learning', diagnosticCount: 3,
    focusId: 'cache-fencing', skills: [{ id: 'cache-fencing', title: 'Cache fencing', level: 1 }] };
  for (const selected of [content, { ...content, chapters: chapters.slice(-1) }]) {
    const prompt = tutor.promptFor(state, { meta: { title: 'Staff systems workbook' }, content: selected }, {},
      'Use the workbook exercise for the current focus.');
    assert.ok(prompt.includes(exercise), 'the focused workbook exercise must not disappear behind earlier chapters');
    const quoted = prompt.split('Quoted workbook and role:\n')[1].split('\nQuoted saved practice progress')[0];
    assert.doesNotThrow(() => JSON.parse(quoted), 'bounded workbook context must remain structurally complete');
  }
});
