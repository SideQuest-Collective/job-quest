const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/podcast/store');
const { registerPodcastRoutes } = require('../lib/podcast/routes');
const { generateEpisode } = require('../lib/podcast/episode');
const audio = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ content: [{ type: 'audio', data: Buffer.alloc(2400).toString('base64') }] }] }) });
function harness(t, fetchFn = audio) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-recording-config-'));
  const dataDir = path.join(dir, 'data'); fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map(), app = {};
  for (const method of ['get', 'put', 'post', 'delete']) app[method] = (url, handler) => handlers.set(`${method} ${url}`, handler);
  registerPodcastRoutes(app, { dataDir, fetchFn, schedule: { status: async () => ({ installed: false, time: null }) } });
  const call = async (method, url, body = {}) => {
    const result = { status: 200 };
    const response = { status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; } };
    await handlers.get(`${method} ${url}`)({ body }, response);
    return result;
  };
  return { dataDir, call };
}

test('recording status tracks the exact model and voices and preference saves make no requests', async (t) => {
  let calls = 0;
  const { dataDir, call } = harness(t, async () => { calls++; return audio(); });
  await call('put', '/api/podcast/config', { apiKey: 'test-key-secret' });
  assert.equal(calls, 1); assert.equal(store.readKeyStatus(dataDir).verified, true);
  await call('put', '/api/podcast/config', { targetMinutes: 12, imessage: false });
  assert.equal(calls, 1); assert.equal(store.readKeyStatus(dataDir).verified, true);
  for (const change of [{ model: 'other-supported-model' }, { hosts: store.readConfig(dataDir).hosts.map((host, i) => i ? host : { ...host, voice: 'Aoede' }) }, { hosts: store.readConfig(dataDir).hosts.map((host, i) => i ? host : { ...host, name: 'Teacher' }) }]) {
    const before = calls;
    const saved = await call('put', '/api/podcast/config', change);
    assert.equal(saved.body.key.code, 'recording-changed'); assert.equal(saved.body.key.verified, false);
    assert.equal(calls, before, 'saving recording preferences makes no network request');
    const blocked = await call('post', '/api/podcast/generate', { force: true });
    assert.equal(blocked.status, 409); assert.equal(calls, before, 'generation requires an explicit recording check');
    const checked = await call('post', '/api/podcast/key/verify');
    assert.equal(checked.body.key.verified, true); assert.equal(calls, before + 1);
    assert.equal(Object.hasOwn(checked.body.key, 'keyHash'), false);
    assert.equal(Object.hasOwn(checked.body.key, 'recordingHash'), false);
    assert.ok(!JSON.stringify(checked.body).includes('test-key-secret'));
  }
});

test('a delayed verification cannot bless settings changed while it was running', async (t) => {
  let release;
  const { dataDir, call } = harness(t, () => new Promise((resolve) => { release = () => resolve(audio()); }));
  store.writeApiKey(dataDir, 'test-key');
  const checking = call('post', '/api/podcast/key/verify');
  await call('put', '/api/podcast/config', { model: 'new-model' });
  release();
  const result = await checking;
  assert.equal(result.body.key.verified, false); assert.equal(result.body.key.code, 'recording-changed');
});

test('legacy key verdicts require one explicit check and do not leak internal hashes', (t) => {
  const { dataDir } = harness(t);
  store.writeApiKey(dataDir, 'test-key');
  store.writeJson(path.join(dataDir, 'podcast/key-status.json'), { keyHash: store.shortHash('test-key'), verified: true, code: 'ok' });
  assert.equal(store.readKeyStatus(dataDir).code, 'recording-changed');
  store.writeKeyStatus(dataDir, 'test-key', { verified: true, code: 'ok' });
  assert.equal(store.readKeyStatus(dataDir).verified, true);
  assert.equal(Object.hasOwn(store.readKeyStatus(dataDir), 'recordingHash'), false);
});

test('scheduled generation stops before network or agent work after recording settings change', async (t) => {
  const { dataDir } = harness(t); store.writeApiKey(dataDir, 'test-key');
  store.writeKeyStatus(dataDir, 'test-key', { verified: true, code: 'ok' });
  store.writeConfig(dataDir, { model: 'changed-model' });
  let calls = 0;
  const episode = await generateEpisode({ dataDir, date: '2026-10-19', force: true, buildSheets: false, group: false, deliver: false, log: () => {}, fetchFn: async () => { calls++; return audio(); }, runAgentFn: async () => { calls++; return {}; } });
  assert.equal(episode.status, 'failed'); assert.equal(episode.errorCode, 'recording-changed'); assert.equal(calls, 0);
});

test('invalid recording preferences return 400 without modifying saved configuration', async (t) => {
  const { dataDir, call } = harness(t); const before = store.readConfig(dataDir);
  for (const patch of [{ hosts: [] }, { hosts: [{ name: 'Same', voice: 'Kore' }, { name: 'same', voice: 'Puck' }] }, { hosts: [{ name: 'Maya', voice: '' }, before.hosts[1]] }, { model: '' }, { model: null }, { imessage: 'true' }, { targetMinutes: 21 }, { topicsPerEpisode: 0 }, { sheetsPerRun: 1.5 }]) {
    const result = await call('put', '/api/podcast/config', patch);
    assert.equal(result.status, 400, JSON.stringify(patch)); assert.deepEqual(store.readConfig(dataDir), before);
  }
});
