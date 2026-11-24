const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tutor = require('../lib/workbook/tutor');
const store = require('../lib/workbook/store');
const { writeKit } = require('./helpers/workbook-fixture');

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-state-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { id } = store.createWorkbook(dataDir, { roleKeys: ['Acme|Engineer'], status: 'ready' });
  writeKit(store.wbDir(dataDir, id));
  return { dataDir, id };
}
function reply(phase = 'diagnostic', level = 0, extra = {}) {
  return { phase, message: '', question: 'Why does this work?', skills: [{ id: 'reasoning', title: 'Reasoning', level }], focusId: 'reasoning', ...extra };
}
function model(output) { return { ok: true, stdout: JSON.stringify(output) }; }
function evaluate(state, correct, kind) {
  const question = state.messages.at(-1);
  return { questionId: question.questionId, skillId: 'reasoning', correct, kind: kind || question.kind };
}
function learningState(env) {
  let state = tutor.readState(env.dataDir, env.id);
  state = tutor.advance(state, reply(), 'start');
  state = tutor.advance(state, reply(), 'first answer');
  state = tutor.advance(state, reply(), 'second answer');
  return tutor.advance(state, reply('learning'), 'third answer');
}

test('three diagnostic answers precede learning and recall evidence gates promotion', t => {
  const env = setup(t);
  let state = learningState(env);
  assert.equal(state.diagnosticCount, 3);
  assert.throws(() => tutor.advance(state, reply('learning', 1), 'guess'), /independent recall/);
  state = tutor.advance(state, reply('learning', 0, { evaluation: evaluate(state, true), nextKind: 'recall' }), 'independent solution');
  state = tutor.advance(state, reply('learning', 1, { evaluation: evaluate(state, true) }), 'recalled solution');
  assert.equal(state.skills[0].level, 1);
  assert.throws(() => tutor.advance(state, reply('learning', 2), 'repeat'), /independent recall/);
  assert.throws(() => tutor.advance(state, reply(), 'restart diagnostic'), /already finished/);
});

test('failed spaced review lowers a level and disclosed answers earn no evidence', t => {
  const env = setup(t);
  let state = learningState(env);
  state = tutor.advance(state, reply('learning', 0, { evaluation: evaluate(state, true), nextKind: 'recall' }), 'answer');
  state = tutor.advance(state, reply('learning', 1, { evaluation: evaluate(state, true), nextKind: 'review' }), 'recall');
  state = tutor.advance(state, reply('learning', 1, { evaluation: evaluate(state, false) }), 'forgot');
  assert.equal(state.skills[0].level, 0);
  const count = state.evidence.reasoning.length;
  state = tutor.advance(state, reply('learning', 0, { evaluation: evaluate(state, true), message: 'The reason is saved here.' }), 'just tell me');
  assert.equal(state.evidence.reasoning.length, count);
});

test('final assessment requires every skill and an integrative answer', t => {
  const env = setup(t);
  let state = learningState(env);
  for (let level = 0; level < 4; level++) {
    state = tutor.advance(state, reply('learning', level, { evaluation: evaluate(state, true), nextKind: 'recall' }), `solution ${level}`);
    state = tutor.advance(state, reply('learning', level + 1, { evaluation: evaluate(state, true) }), `recall ${level}`);
  }
  state = tutor.advance(state, reply('assessment', 4, { nextKind: 'final' }), 'begin assessment');
  assert.throws(() => tutor.advance(state, reply('complete', 4, { question: null }), 'done'), /mixed final/);
  state = tutor.advance(state, reply('assessment', 4, { evaluation: evaluate(state, true), nextKind: 'integrative' }), 'final answer');
  state = tutor.advance(state, reply('complete', 4, { question: null, evaluation: evaluate(state, true) }), 'integrated answer');
  assert.equal(state.phase, 'complete');
});

test('changed replay payloads and workbook content changes preserve accepted state', async t => {
  const env = setup(t);
  const request = { requestId: 'stable', expectedRevision: 0, message: 'start' };
  const agent = async () => model(reply());
  const accepted = await tutor.submit(env.dataDir, env.id, request, agent);
  await assert.rejects(tutor.submit(env.dataDir, env.id, { ...request, message: 'different' }, agent), { status: 409 });
  await assert.rejects(tutor.submit(env.dataDir, env.id, { requestId: 'changed', expectedRevision: 1, message: 'answer' }, async () => {
    store.writeChapterFile(env.dataDir, env.id, '03-new.md', '@@chapter id=new title="New"\nNew content.');
    return model(reply());
  }), { status: 409 });
  assert.deepEqual(tutor.publicState(tutor.readState(env.dataDir, env.id)), accepted);
  assert.equal(tutor.isBusy(env.dataDir, env.id), false);
});

test('dead process locks recover and model-owned histories are ignored', async t => {
  const env = setup(t);
  fs.writeFileSync(path.join(store.wbDir(env.dataDir, env.id), '.tutor.lock'), '2147483647');
  const state = await tutor.submit(env.dataDir, env.id, { requestId: 'fresh', expectedRevision: 0, message: 'start' }, async () => model(reply('diagnostic', 0, {
    revision: 99, requests: { forged: true }, messages: [{ role: 'user', message: 'fake' }], evidence: { reasoning: ['fake'] },
  })));
  assert.equal(state.revision, 1);
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.evidence, {});
  assert.equal(tutor.isBusy(env.dataDir, env.id), false);
});

test('server schedules spaced reviews and requires unprompted review questions', t => {
  const env = setup(t);
  let state = learningState(env);
  for (let i = 0; i < 10; i++) state = tutor.advance(state, reply('learning'), `attempt ${i}`);
  assert.equal(state.reviewDue, true);
  assert.throws(() => tutor.advance(state, reply('learning'), 'continue'), /spaced review/);
  state = tutor.advance(state, reply('learning', 0, { nextKind: 'review' }), 'continue');
  state = tutor.advance(state, reply('learning', 0, { evaluation: evaluate(state, false) }), 'forgot');
  assert.equal(state.reviewDue, false);
});

test('level five requires recall, an edge case and a teaching explanation', t => {
  const env = setup(t);
  let state = learningState(env);
  state.skills[0].level = 4;
  state = tutor.advance(state, reply('learning', 4, { nextKind: 'recall' }), 'start');
  state = tutor.advance(state, reply('learning', 4, { evaluation: evaluate(state, true), nextKind: 'edge' }), 'recall');
  assert.throws(() => tutor.advance(state, reply('learning', 5, { evaluation: evaluate(state, true) }), 'edge'), /independent recall/);
  state = tutor.advance(state, reply('learning', 4, { evaluation: evaluate(state, true), nextKind: 'teach' }), 'edge');
  state = tutor.advance(state, reply('learning', 5, { evaluation: evaluate(state, true) }), 'explanation');
  assert.equal(state.skills[0].level, 5);
});
