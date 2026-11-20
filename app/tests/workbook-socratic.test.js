const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/workbook/store');
const { registerWorkbookRoutes } = require('../lib/workbook/routes');
const { writeKit } = require('./helpers/workbook-fixture');
const prompts = require('../lib/workbook/prompts');
const { assignIds } = require('../lib/workbook/outline');
const { screenOutline } = require('./helpers/workbook-outlines');

function setup(t, runAgent) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-socratic-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const meta = store.createWorkbook(dataDir, { roleKeys: ['Acme|Staff Engineer'], status: 'ready', source: 'imported' });
  writeKit(store.wbDir(dataDir, meta.id));
  store.writeProgress(dataDir, meta.id, { answers: { 'intro-2': 'my original answer' } });
  const calls = [];
  function routes() {
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, fn) => handlers.set(`${method} ${url}`, fn)]));
    registerWorkbookRoutes(app, {
      dataDir, queue: { list: () => [] }, autoBuild: {}, publicDir: path.resolve(__dirname, '../public'),
      tutorRunAgent: async options => { calls.push(options); return runAgent(options, calls.length); },
    });
    return async function request(method, body, id = meta.id) {
      const handler = handlers.get(`${method} /api/workbooks/:id/tutor`);
      assert.equal(typeof handler, 'function', `${method.toUpperCase()} workbook tutor route must be registered`);
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      await handler({ params: { id }, body }, res);
      return { status: res.statusCode, body: res.body };
    };
  }
  return { dataDir, meta, calls, routes, request: routes() };
}

// This is the structured agent reply contract. Server-owned revisions, request IDs,
// conversation history and promotion evidence must never be accepted from the model.
function reply(overrides = {}) {
  return { ok: true, code: 0, stdout: JSON.stringify({ phase: 'diagnostic', message: '',
    question: 'What changes when a widget feed has a million readers?',
    skills: [{ id: 'fanout', title: 'Fan-out', level: 0 }], focusId: 'fanout', ...overrides }) };
}
const turn = (requestId, expectedRevision, message = 'Start tutoring me') => ({ requestId, expectedRevision, message });

test('old imported workbooks offer an idle tutor without changing saved work or starting an agent', async t => {
  const env = setup(t, () => reply());
  const before = fs.readFileSync(path.join(store.wbDir(env.dataDir, env.meta.id), 'progress.json'), 'utf8');
  const response = await env.request('get');
  assert.equal(response.status, 200);
  assert.equal(response.body.revision, 0);
  assert.equal(response.body.phase, 'idle');
  assert.deepEqual(response.body.messages, []);
  assert.equal(env.calls.length, 0);
  assert.equal((await env.request('get', undefined, 'missing-workbook')).status, 404);
  assert.equal(fs.readFileSync(path.join(store.wbDir(env.dataDir, env.meta.id), 'progress.json'), 'utf8'), before);
});

test('a tutor turn is grounded in workbook content, saved on the server and replayed without another model call', async t => {
  const env = setup(t, () => reply());
  const response = await env.request('post', turn('turn-one', 0));
  assert.equal(response.status, 200);
  assert.equal(response.body.phase, 'diagnostic');
  assert.equal(response.body.revision, 1);
  assert.equal(response.body.messages.at(-1).question, 'What changes when a widget feed has a million readers?');
  assert.ok(env.calls[0].prompt.includes('Design a widget feed.'));
  assert.match(env.calls[0].prompt, /Socratic/i);
  assert.equal(env.calls[0].profile, 'read');
  assert.ok(env.calls[0].timeoutMs > 0 && env.calls[0].timeoutMs <= 180000);
  assert.deepEqual((await env.routes()('get')).body, response.body, 'new handler instance resumes server state');
  assert.deepEqual((await env.request('post', turn('turn-one', 0))).body, response.body);
  assert.equal(env.calls.length, 1, 'retry replays the successful turn');
  assert.equal((await env.request('post', turn('stale-turn', 0, 'I would cache the feed'))).status, 409);
  assert.equal(env.calls.length, 1, 'stale clients cannot spend a call');
  assert.equal(store.readProgress(env.dataDir, env.meta.id).answers['intro-2'], 'my original answer');
});

test('concurrent submissions cannot overwrite a tutor turn or run two agents', async t => {
  let release;
  const env = setup(t, () => new Promise(resolve => { release = () => resolve(reply()); }));
  const first = env.request('post', turn('first', 0));
  await new Promise(setImmediate);
  const second = await env.request('post', turn('second', 0));
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(env.calls.length, 1);
  assert.equal((await env.request('get')).body.revision, 1);
});

test('failed and malformed model replies preserve the last accepted conversation and allow a retry', async t => {
  const env = setup(t, (_options, n) => n === 1 ? reply() : n === 2 ? { ok: false, code: 1, stdout: '' } : n === 3 ? { ok: true, code: 0, stdout: 'broken JSON' } : reply());
  const accepted = (await env.request('post', turn('start', 0))).body;
  for (const requestId of ['failed', 'malformed']) {
    assert.ok((await env.request('post', turn(requestId, 1, 'I am unsure'))).status >= 400);
    assert.deepEqual((await env.request('get')).body, accepted);
  }
  assert.equal((await env.request('post', turn('retry', 1, 'I am unsure'))).status, 200);
});

test('unearned mastery and an early final assessment cannot complete a fresh diagnostic', async t => {
  const env = setup(t, () => reply({ phase: 'complete', skills: [{ id: 'fanout', title: 'Fan-out', level: 5 }] }));
  const response = await env.request('post', turn('inflate', 0));
  assert.ok(response.status >= 400 || (response.body.phase !== 'complete' && response.body.skills.every(skill => skill.level < 4)));
  assert.notEqual((await env.request('get')).body.phase, 'complete');
});

test('tutor instructions preserve the upstream teaching controls and explicit answer override', async t => {
  const env = setup(t, () => reply());
  await env.request('post', turn('start', 0));
  const prompt = env.calls[0].prompt;
  for (const requirement of [/one question at a time/i, /diagnostic/i, /independent checks/i, /unprompted recall/i,
    /spaced review/i, /final assessment/i, /just tell me/i]) assert.match(prompt, requirement);
  await env.request('post', turn('override', 1, 'just tell me'));
  assert.match(env.calls[1].prompt, /just tell me/i);
  assert.equal((await env.request('get')).body.revision, 2);
  assert.equal(store.readProgress(env.dataDir, env.meta.id).answers['intro-2'], 'my original answer');
});

test('invalid tutor requests fail before starting an agent', async t => {
  const env = setup(t, () => reply());
  for (const body of [{}, turn('blank', 0, ''), turn('negative', -1), { message: 'start', expectedRevision: 0 }]) {
    assert.equal((await env.request('post', body)).status, 400);
  }
  assert.equal(env.calls.length, 0);
});

test('new workbook plans and chapters teach through diagnostic, reasoning, review and assessment', () => {
  const meta = { company: 'Acme', role: 'Staff Engineer', companyNames: { acme: 'Acme' } };
  const args = { meta, profile: {}, research: 'Verified role research', tier: 'screen', chapter: assignIds(screenOutline()).chapters[0] };
  for (const prompt of [prompts.plannerPrompt(args), prompts.writerPrompt(args)]) {
    assert.match(prompt, /Socratic/i);
    assert.match(prompt, /diagnostic/i);
    assert.match(prompt, /predict|reason|explain why/i);
    assert.match(prompt, /spaced review/i);
    assert.match(prompt, /final assessment/i);
  }
});
