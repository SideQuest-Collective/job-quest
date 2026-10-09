const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQueue } = require('../lib/jobs/queue');
const { createFeedbackService, parseEvaluation, read, write } = require('../lib/feedback/service');
const { createRequestBoundary, validConversationId } = require('../lib/feedback/boundary');
const { withServer, post } = require('./helpers/server');
const grade = (extra = {}) => JSON.stringify({ score: 7, maxScore: 10, strengths: ['Specific'], improvements: ['Measure results'], feedback: 'A useful answer.', complete: true, ...extra });
function harness(t, evaluate = async () => grade()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-feedback-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = {}, queue = createQueue({ dataDir: dir, handlers });
  const service = createFeedbackService({ dataDir: dir, queue, handlers, evaluate });
  return { dir, queue, service, handlers };
}
const answer = { key: 'bq_stable', question: 'Describe a conflict.', userAnswer: 'I resolved a concrete disagreement.' };
test('invalid reviews never turn into a zero; genuine zero remains a grade', () => {
  for (const value of ['oops', '{}', '{"error":true}', grade({ score: null }), grade({ score: 11 }), grade({ score: '7' }), grade({ feedback: '' }), grade({ strengths: 'good' }), grade({ followUp: {} }), grade({ progress: {} }), grade({ complete: 'yes' })]) assert.throws(() => parseEvaluation(value), /invalid review/);
  assert.equal(parseEvaluation(grade({ score: 0 })).score, 0);
  assert.equal(parseEvaluation('```json\n' + grade() + '\n```').score, 7);
});
test('answer is durable before coach starts, reload sees pending, retry retains one attempt and grade', async t => {
  let h, calls = 0;
  h = harness(t, async () => {
    assert.equal(read(path.join(h.dir, 'behavioral/answers.json'), {})[answer.key].answer, answer.userAnswer);
    assert.equal(h.service.list()[0].answer, answer.userAnswer);
    if (++calls === 1) throw new Error('Coach unavailable');
    return grade({ score: 0 });
  });
  const { attempt } = h.service.submit('behavioral', { ...answer, attemptId: 'attempt_one' });
  assert.equal(h.service.get(attempt.id).status, 'running');
  await h.queue.drain();
  assert.equal(h.service.get(attempt.id).status, 'failed');
  assert.equal(h.service.get(attempt.id).evaluation, undefined);
  assert.equal(read(path.join(h.dir, 'behavioral/answers.json'), {})[answer.key].evaluation, undefined);
  h.service.retry(attempt.id); await h.queue.drain();
  assert.equal(h.service.get(attempt.id).evaluation.score, 0);
  h.service.retry(attempt.id); await h.queue.drain();
  assert.equal(calls, 2); assert.equal(h.service.list().length, 1);
});
test('client retry with same id deduplicates; changed content conflicts', async t => {
  const h = harness(t);
  h.service.submit('behavioral', { ...answer, attemptId: 'one' });
  h.service.submit('behavioral', { ...answer, attemptId: 'one' });
  assert.throws(() => h.service.submit('behavioral', { ...answer, attemptId: 'one', userAnswer: 'changed' }), { status: 409 });
  await h.queue.drain(); assert.equal(h.queue.list().length, 1);
});
test('late review retains submitted evidence but never overwrites a new draft', async t => {
  let finish;
  const h = harness(t, () => new Promise(resolve => { finish = resolve; }));
  const { attempt } = h.service.submit('behavioral', answer);
  const file = path.join(h.dir, 'behavioral/answers.json'), current = read(file, {});
  current[answer.key].answer = 'A newer draft'; current[answer.key].revision++; write(file, current);
  finish(grade()); await h.queue.drain();
  assert.equal(h.service.get(attempt.id).status, 'done'); assert.equal(h.service.get(attempt.id).superseded, true);
  assert.equal(read(file, {})[answer.key].answer, 'A newer draft'); assert.equal(read(file, {})[answer.key].evaluation, undefined);
});
test('trainer failure preserves answer, retry appends one exchange and keeps newer draft', async t => {
  let calls = 0, finish;
  const h = harness(t, async () => { if (++calls === 1) return 'bad JSON'; return new Promise(resolve => { finish = resolve; }); });
  const file = path.join(h.dir, 'trainer/questions.json');
  write(file, [{ id: 'q1', question: 'Why?', status: 'pending', draft: 'first', draftRevision: 1 }]);
  const { attempt } = h.service.submit('trainer', { id: 'q1', answer: 'first', expectedRevision: 1 });
  await h.queue.drain(); assert.equal(h.service.get(attempt.id).status, 'failed');
  assert.equal(read(file, [])[0].evaluation, undefined);
  h.service.retry(attempt.id);
  const qs = read(file, []); qs[0].draft = 'newer'; qs[0].draftRevision++; write(file, qs);
  finish(grade({ followUp: 'How?', complete: false })); await h.queue.drain();
  const q = read(file, [])[0]; assert.equal(q.draft, 'newer'); assert.equal(q.status, 'in-progress'); assert.equal(q.exchanges.length, 2);
  await h.handlers.feedback({ payload: { attemptId: attempt.id } });
  assert.equal(read(file, [])[0].exchanges.length, 2);
});
test('restart resumes persisted running review; missing queued job is repaired only after recover', async t => {
  const h = harness(t);
  write(path.join(h.dir, 'feedback/recovered.json'), { id: 'recovered', questionId: 'q1', kind: 'behavioral', answer: 'saved', context: { question: 'Why?' }, status: 'running', createdAt: '2026-01-01', answerRevision: 1 });
  write(path.join(h.dir, 'behavioral/answers.json'), { q1: { answer: 'saved', revision: 1 } });
  assert.equal(h.queue.list().length, 0);
  h.service.recover(); await h.queue.drain();
  assert.equal(h.service.get('recovered').status, 'done'); assert.equal(h.queue.list().length, 1);
});
function boundary(headers, method = 'POST', origins = '', tailscaleUser = '', remoteAddress = '127.0.0.1') {
  let status = 200, next = false;
  createRequestBoundary({ origins, tailscaleUser })({ headers: { host: '127.0.0.1:3847', ...headers }, socket: { localPort: 3847, remoteAddress }, method, is: type => headers['content-type'] === type }, { status(value) { status = value; return this; }, json() {} }, () => { next = true; });
  return { status, next };
}
test('request boundary rejects foreign hosts/origins and accepts explicit private proxy origin', () => {
  assert.equal(boundary({ host: 'evil.example:3847' }).status, 403);
  assert.equal(boundary({ origin: 'https://evil.example' }).status, 403);
  assert.equal(boundary({ origin: 'null' }).status, 403);
  assert.equal(boundary({ 'sec-fetch-site': 'cross-site' }).status, 403);
  assert.equal(boundary({ origin: 'http://127.0.0.1:3847' }).next, true);
  assert.equal(boundary({}).next, true);
  assert.equal(boundary({ 'content-length': '3', 'content-type': 'text/plain' }).status, 415);
  assert.equal(boundary({ origin: 'https://private.example', 'tailscale-user-login': 'owner@example.test' }, 'POST', 'https://private.example', 'owner@example.test').next, true);
  assert.equal(boundary({ host: 'private.example', origin: 'http://private.example' }, 'POST', 'https://private.example').status, 403);
  assert.equal(boundary({ host: 'private.example', 'tailscale-user-login': 'owner@example.test' }, 'GET', 'https://private.example', 'owner@example.test').next, true);
  assert.equal(boundary({ host: 'private.example' }, 'POST', 'https://private.example').status, 403);
});
test('private proxy identity is exact, required and trusted only on loopback', () => {
  const headers = { host: 'private.example', origin: 'https://private.example', 'tailscale-user-login': 'owner@example.test' };
  assert.equal(boundary(headers, 'POST', 'https://private.example', 'owner@example.test').next, true);
  for (const user of [undefined, 'other@example.test', 'owner@example.test,other@example.test']) assert.equal(boundary({ ...headers, 'tailscale-user-login': user }, 'POST', 'https://private.example', 'owner@example.test').status, 403);
  assert.equal(boundary(headers, 'POST', 'https://private.example', 'owner@example.test', '100.100.10.10').status, 403);
  assert.equal(boundary({ 'x-forwarded-for': '1.2.3.4' }).status, 403);
  assert.equal(boundary({}).next, true);
});
test('conversation ids cannot traverse paths or address object prototypes', () => {
  for (const id of ['../profile', '/tmp/test', '__proto__', 'constructor', '', null, {}, 'x'.repeat(129)]) assert.equal(validConversationId(id), false);
  assert.equal(validConversationId(undefined), true); assert.equal(validConversationId('abc-123'), true);
});
test('server draft save supports clearing, revisions, and ignores client-authored evaluation', async t => {
  const h = harness(t);
  write(path.join(h.dir, 'trainer/questions.json'), [{ id: 'q1', question: 'Why?', answer: 'Historical answer', status: 'answered' }]);
  await withServer(h.dir, async base => {
    let r = await fetch(`${base}/api/behavioral/answers`, post({ key: 'bq_1', answer: 'draft', evaluation: { score: 0 } }));
    assert.equal(r.status, 200); assert.equal((await r.json()).answer.evaluation, undefined);
    r = await fetch(`${base}/api/behavioral/answers`, post({ key: 'bq_1', answer: '', expectedRevision: 1 })); assert.equal(r.status, 200);
    assert.equal((await r.json()).answer.answer, '');
    r = await fetch(`${base}/api/behavioral/answers`, post({ key: 'bq_1', answer: 'stale', expectedRevision: 1 })); assert.equal(r.status, 409);
    r = await fetch(`${base}/api/trainer/answer`, post({ id: 'q1', answer: '', expectedRevision: 0 })); assert.equal(r.status, 200);
    const q = (await r.json()).question; assert.equal(q.answer, 'Historical answer'); assert.equal(q.draft, '');
    r = await fetch(`${base}/api/code-review`, post({ conversationId: '../profile' })); assert.equal(r.status, 400);
    r = await fetch(`${base}/api/trainer/answer`, { ...post({ id: 'q1', answer: 'bad' }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }); assert.equal(r.status, 403);
  });
});
test('conversational wrapper uses read-only execution and cleans up on failure', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../../skill/bin/code-review.sh'), 'utf8');
  assert.match(script, /--sandbox read-only/); assert.doesNotMatch(script, /workspace-write/);
  assert.match(script, /trap .*PROMPT_FILE.* EXIT/); assert.match(script, /--disallowed-tools Bash,Edit,Read,Write,Glob,Grep,Agent/);
});

test('feedback subprocess returns output, cleans private prompts, and terminates timeout process groups', async t => {
  const { runEvaluator } = require('../lib/feedback/service');
  const h = harness(t);
  const runner = path.join(h.dir, 'fake-evaluator.sh');
  const marker = path.join(h.dir, 'prompt-path.txt');
  fs.writeFileSync(runner, `printf '%s' "$1" > '${marker}'\ncat "$1"\n`);
  assert.equal(await runEvaluator('synthetic prompt', { scriptPath: runner }), 'synthetic prompt');
  assert.equal(fs.existsSync(fs.readFileSync(marker, 'utf8')), false);
  fs.writeFileSync(runner, `printf '%s' "$1" > '${marker}'\nsleep 30 &\nwait\n`);
  const started = Date.now();
  await assert.rejects(runEvaluator('synthetic prompt', { scriptPath: runner, timeoutMs: 50 }), /answer is saved/);
  assert.ok(Date.now() - started < 3000);
  assert.equal(fs.existsSync(fs.readFileSync(marker, 'utf8')), false);
});
test('target level comes from the saved profile and is included in submitted review context', async t => {
  const { targetLevel } = require('../lib/feedback/service');
  let prompt;
  const h = harness(t, async value => { prompt = value; return grade(); });
  assert.equal(targetLevel(h.dir), 'the candidate’s target role');
  write(path.join(h.dir, 'profile.json'), { targetLevel: 'Senior/L5' });
  h.service.submit('behavioral', answer); await h.queue.drain();
  assert.match(prompt, /Senior\/L5/); assert.doesNotMatch(prompt, /Staff\/L6/);
});

test('completed review adds one activity event; retry, replay and summary recovery do not duplicate credit', async t => {
  let calls = 0;
  const h = harness(t, async () => { if (++calls === 1) throw new Error('temporary failure'); return grade(); });
  const { attempt } = h.service.submit('behavioral', answer);
  await h.queue.drain(); assert.equal(fs.existsSync(path.join(h.dir, 'activity.json')), false);
  h.service.retry(attempt.id); await h.queue.drain();
  const events = () => Object.values(read(path.join(h.dir, 'activity.json'), {})).flatMap(day => day.events);
  assert.equal(events().length, 1); assert.equal(events()[0].detail.attemptId, attempt.id);
  assert.equal(events()[0].detail.score, 7);
  // Simulate a crash after the activity append, before marking it recorded.
  const record = h.service.get(attempt.id); delete record.activityRecorded;
  write(path.join(h.dir, `feedback/${attempt.id}.json`), record);
  h.service.recover(); await h.handlers.feedback({ payload: { attemptId: attempt.id } });
  h.service.retry(attempt.id); await h.queue.drain();
  assert.equal(events().length, 1); assert.equal(calls, 2);
  assert.equal(h.service.get(attempt.id).activityRecorded, true);
});
test('secondary activity failure preserves valid feedback and recovers without AI', async t => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return grade(); });
  fs.writeFileSync(path.join(h.dir, 'activity.json'), 'corrupt existing data');
  const { attempt } = h.service.submit('behavioral', answer); await h.queue.drain();
  assert.equal(h.service.get(attempt.id).status, 'done'); assert.equal(h.service.get(attempt.id).evaluation.score, 7);
  assert.ok(h.service.get(attempt.id).activityError);
  assert.equal(fs.readFileSync(path.join(h.dir, 'activity.json'), 'utf8'), 'corrupt existing data');
  write(path.join(h.dir, 'activity.json'), {}); h.service.recover();
  assert.equal(h.service.get(attempt.id).activityRecorded, true); assert.equal(calls, 1);
});
test('coaching receives assistance and source snapshots with honest mastery instructions', async t => {
  let prompt;
  const h = harness(t, async value => { prompt = value; return grade(); });
  const assistance = { mode: 'reference-open', answerRevealed: true };
  const source = { kind: 'concept', id: 'hash-tables', hash: 'abc' };
  const { attempt } = h.service.submit('behavioral', { ...answer, assistance, source }); await h.queue.drain();
  assert.match(prompt, /reference-open/); assert.match(prompt, /answerRevealed/); assert.match(prompt, /hash-tables/);
  assert.match(prompt, /never describe an assisted or revealed response as proof of independent mastery/);
  assert.deepEqual(h.service.get(attempt.id).assistance, assistance); assert.deepEqual(h.service.get(attempt.id).source, source);
});
