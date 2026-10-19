const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withServer, post } = require('./helpers/server');
const {
  findSdScore, sdFeedbackGiven, sdConversationStatus, sdTopicState, buildSdWrapUpPrompt, completeSdConversation,
} = require('../lib/sd-interview');

const msg = (role, content) => ({ role, content, timestamp: '2026-10-18T12:00:00.000Z' });
const started = () => ({ messages: [msg('user', '[Interview started]'), msg('assistant', 'Design a URL shortener. What would you clarify?')] });
const naturalEnd = () => ({ messages: [...started().messages, msg('user', 'Reads dominate, 100:1.'), msg('assistant', '## Feedback\nGood requirements work.\n\n**Score: 7/10**')] });

test('findSdScore reads the common score phrasings and ignores others', () => {
  assert.equal(findSdScore('**Score: 7/10**'), 7);
  assert.equal(findSdScore('I would give this 6.5 / 10.'), 6.5);
  assert.equal(findSdScore('Score: 8 out of 10'), 8);
  assert.equal(findSdScore('Handle 10/100 of the traffic'), null);
  assert.equal(findSdScore('What would you clarify?'), null);
  assert.equal(findSdScore(undefined), null);
});

test('status is new, in-progress, then completed', () => {
  assert.equal(sdConversationStatus(null), 'new');
  assert.equal(sdConversationStatus({ messages: [] }), 'new');
  const conv = started();
  assert.equal(sdConversationStatus(conv), 'in-progress');
  completeSdConversation(conv, { now: '2026-10-18T13:00:00.000Z' });
  assert.equal(sdConversationStatus(conv), 'completed');
  assert.deepEqual(sdTopicState(conv), { hasConversation: true, status: 'completed', completedAt: '2026-10-18T13:00:00.000Z', score: null });
  assert.deepEqual(sdTopicState(null), { hasConversation: false, status: 'new', completedAt: null, score: null });
});

test('ending early appends the final feedback, keeps earlier messages, and records the score', () => {
  const conv = started();
  const before = JSON.parse(JSON.stringify(conv.messages));
  completeSdConversation(conv, { feedback: 'Went well: scope.\n\nScore: 4/10', now: '2026-10-18T13:00:00.000Z' });
  assert.deepEqual(conv.messages.slice(0, before.length), before);
  assert.equal(conv.messages.length, before.length + 1);
  assert.equal(conv.messages.at(-1).kind, 'feedback');
  assert.equal(conv.score, 4);
  assert.equal(conv.endedEarly, true);
  assert.equal(conv.completedAt, '2026-10-18T13:00:00.000Z');
});

test('a natural end uses the feedback already in the chat and is not marked early', () => {
  const conv = naturalEnd();
  assert.equal(sdFeedbackGiven(conv), true);
  completeSdConversation(conv);
  assert.equal(conv.messages.length, 4);
  assert.equal(conv.score, 7);
  assert.equal(conv.endedEarly, false);
});

test('completing twice changes nothing', () => {
  const conv = naturalEnd();
  completeSdConversation(conv, { now: 'first' });
  const snapshot = JSON.stringify(conv);
  completeSdConversation(conv, { feedback: 'more', now: 'second' });
  assert.equal(JSON.stringify(conv), snapshot);
});

test('the wrap-up prompt asks for final scored feedback without new questions', () => {
  const prompt = buildSdWrapUpPrompt({ title: 'Design a URL Shortener' }, started());
  assert.match(prompt, /Design a URL Shortener/);
  assert.match(prompt, /ended the interview early/);
  assert.match(prompt, /Do not ask any more questions/);
  assert.match(prompt, /Score: N\/10/);
  assert.match(prompt, /INTERVIEWER: Design a URL shortener/);
});

test('real routes save completion, survive a reload, block new messages, and restart clears it', async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-sd-complete-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const dir = path.join(data, 'sd-conversations');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'url-shortener.json'), JSON.stringify(naturalEnd(), null, 2));
  fs.writeFileSync(path.join(dir, 'news-feed.json'), JSON.stringify(started(), null, 2));

  await withServer(data, async base => {
    const topic = async id => (await (await fetch(`${base}/api/sd-topics`)).json()).find(x => x.id === id);
    assert.equal((await topic('url-shortener')).status, 'in-progress');
    assert.equal((await topic('chat-system')).status, 'new');

    let r = await fetch(`${base}/api/sd-conversation/chat-system/complete`, post({}));
    assert.equal(r.status, 409, 'cannot end an interview that never started');

    // Natural end: the interviewer already scored it, so no runtime call is needed.
    r = await fetch(`${base}/api/sd-conversation/url-shortener/complete`, post({}));
    assert.equal(r.status, 200);
    let conv = await r.json();
    assert.ok(conv.completedAt);
    assert.equal(conv.score, 7);
    assert.equal(conv.messages.length, 4);

    // Early end without feedback (for when the runtime is unavailable).
    r = await fetch(`${base}/api/sd-conversation/news-feed/complete`, post({ skipFeedback: true }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).endedEarly, true);

    // Reload: state comes back from disk.
    conv = await (await fetch(`${base}/api/sd-conversation/url-shortener`)).json();
    assert.ok(conv.completedAt);
    const listed = await topic('url-shortener');
    assert.equal(listed.status, 'completed');
    assert.equal(listed.score, 7);
    assert.equal(listed.hasConversation, true);

    r = await fetch(`${base}/api/sd-conversation/url-shortener`, post({ userMessage: 'one more thing' }));
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'url-shortener.json'), 'utf8')).messages.length, 4);

    r = await fetch(`${base}/api/sd-conversation/url-shortener/complete`, post({}));
    assert.equal((await r.json()).completedAt, conv.completedAt, 'completing again is a no-op');

    r = await fetch(`${base}/api/sd-conversation/url-shortener`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal((await topic('url-shortener')).status, 'new');
  });
});

test('the page helpers count completed topics apart from in-progress ones and match the server score reader', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const block = html.match(/\/\* ===== SD TOPIC GROUPS ===== \*\/([\s\S]*?)\/\* ===== END SD TOPIC GROUPS ===== \*\//);
  const ui = vm.runInThisContext(`(() => { ${block[1]}\nreturn { groupSdTopics, sdTopicCompleted, findSdScore, sdFeedbackGiven }; })()`);
  const groups = ui.groupSdTopics([
    { id: 'a', hasConversation: true, status: 'in-progress' },
    { id: 'b', hasConversation: true, status: 'completed', score: 7 },
    { id: 'c', hasConversation: false, status: 'new' },
  ]);
  assert.equal(groups[0].inProgress, 1);
  assert.equal(groups[0].completed, 1);
  assert.equal(ui.sdTopicCompleted({ status: 'completed' }), true);
  assert.equal(ui.sdTopicCompleted({ hasConversation: true }), false);
  for (const text of ['**Score: 7/10**', '6.5 / 10', '8 out of 10', '10/100', 'no score', undefined]) {
    assert.equal(ui.findSdScore(text), findSdScore(text), String(text));
  }
  assert.equal(ui.sdFeedbackGiven(naturalEnd().messages), true);
  assert.equal(ui.sdFeedbackGiven(started().messages), false);
});
