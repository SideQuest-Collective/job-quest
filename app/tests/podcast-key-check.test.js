const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const store = require('../lib/podcast/store');
const { verifyApiKey } = require('../lib/podcast/verify');
const { registerPodcastRoutes } = require('../lib/podcast/routes');
const { generateEpisode } = require('../lib/podcast/episode');

const HOSTS = store.DEFAULT_CONFIG.hosts;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const audioFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ content: [{ type: 'audio', data: Buffer.alloc(2400).toString('base64') }] }] }) });
const geminiError = (status, message, reason) => async () => ({ ok: false, status, text: async () => JSON.stringify([{ error: { code: status, message, status: reason } }]) });
const PREPAY = 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.';

test('verifyApiKey: a key that returns audio is verified', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return audioFetch(); };
  const r = await verifyApiKey({ apiKey: 'k', model: 'm', hosts: HOSTS, fetchFn });
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.code, 'ok');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(calls[0].init.body);
  assert.strictEqual(body.model, 'm');
  assert.ok(body.input[0].content[0].text.length < 80, 'the probe is a single short line');
});

test('verifyApiKey: depleted prepaid credits explain how to fix billing', async () => {
  const r = await verifyApiKey({ apiKey: 'k', model: 'm', hosts: HOSTS, fetchFn: geminiError(402, PREPAY, 'RESOURCE_EXHAUSTED') });
  assert.strictEqual(r.verified, false);
  assert.strictEqual(r.code, 'billing');
  assert.match(r.message, /prepayment credits are depleted/);
  assert.match(r.remediation, /ai\.studio\/projects/);
  assert.match(r.remediation, /free tier/);
});

test('verifyApiKey: an invalid key says to make a new one', async () => {
  const r = await verifyApiKey({ apiKey: 'k', model: 'm', hosts: HOSTS, fetchFn: geminiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT') });
  assert.strictEqual(r.code, 'invalid-key');
  assert.match(r.remediation, /aistudio\.google\.com\/apikey/);
});

test('verifyApiKey: missing model, rate limits and network failures are distinct', async () => {
  assert.strictEqual((await verifyApiKey({ apiKey: 'k', model: 'm', hosts: HOSTS, fetchFn: geminiError(404, 'models/m is not found', 'NOT_FOUND') })).code, 'model');
  assert.strictEqual((await verifyApiKey({ apiKey: 'k', model: 'm', hosts: HOSTS, fetchFn: geminiError(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED') })).code, 'rate-limited');
  const net = await verifyApiKey({ apiKey: 'k', model: 'm', hosts: HOSTS, fetchFn: async () => { throw new Error('ECONNRESET'); } });
  assert.strictEqual(net.code, 'network');
  assert.match(net.remediation, /connection/i);
  assert.strictEqual((await verifyApiKey({ apiKey: '', model: 'm', hosts: HOSTS, fetchFn: audioFetch })).code, 'no-key');
});

test('key status is remembered per key and forgotten when the key changes', () => {
  const d = path.join(tmp('jq-key-'), 'data');
  fs.mkdirSync(d);
  delete process.env.GEMINI_API_KEY;
  assert.strictEqual(store.readKeyStatus(d).code, 'no-key');
  store.writeApiKey(d, 'first');
  assert.strictEqual(store.readKeyStatus(d).code, 'unchecked');
  store.writeKeyStatus(d, 'first', { verified: false, code: 'billing', message: 'm', remediation: 'r', checkedAt: '2026-10-15T00:00:00Z' });
  assert.strictEqual(store.readKeyStatus(d).code, 'billing');
  store.writeApiKey(d, 'second');
  assert.strictEqual(store.readKeyStatus(d).code, 'unchecked', 'a new key starts unverified');
});

function routeHarness(t, { fetchFn }) {
  const d = path.join(tmp('jq-key-routes-'), 'data');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'role-tracker.json'), JSON.stringify({ 'Citadel|SWE': { stage: 'onsite' } }));
  const schedule = { status: async () => ({ installed: true, time: '08:30' }), install: async () => ({ installed: true, time: '08:30' }), uninstall: async () => ({ installed: false, time: null }) };
  const app = express();
  app.use(express.json());
  registerPodcastRoutes(app, { dataDir: d, schedule, fetchFn });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { d, call };
}

test('saving a key checks it, reports the fix, and blocks episodes until it passes', async (t) => {
  delete process.env.GEMINI_API_KEY;
  let gemini = geminiError(402, PREPAY, 'RESOURCE_EXHAUSTED');
  const { call } = routeHarness(t, { fetchFn: (...a) => gemini(...a) });

  const saved = await call('PUT', '/api/podcast/config', { apiKey: 'k-402' });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.hasKey, true);
  assert.strictEqual(saved.body.key.verified, false);
  assert.strictEqual(saved.body.key.code, 'billing');
  assert.match(saved.body.key.remediation, /ai\.studio\/projects/);

  const onb = (await call('GET', '/api/podcast/onboarding')).body;
  assert.strictEqual(onb.key.code, 'billing');
  assert.strictEqual(onb.show, true, 'an unverified key does not count as configured');

  const blocked = await call('POST', '/api/podcast/generate', { force: true });
  assert.strictEqual(blocked.status, 409);
  assert.match(blocked.body.error, /prepayment credits/);
  assert.match(blocked.body.error, /ai\.studio\/projects/);

  gemini = audioFetch;
  const again = await call('POST', '/api/podcast/key/verify');
  assert.strictEqual(again.body.key.verified, true);
  assert.strictEqual((await call('GET', '/api/podcast')).body.key.verified, true);
  assert.strictEqual((await call('GET', '/api/podcast/onboarding')).body.show, false);
});

test('a scheduled run stops before any agent work when the key cannot record audio', async () => {
  const d = path.join(tmp('jq-key-run-'), 'data');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'role-tracker.json'), JSON.stringify({ 'Citadel|SWE': { stage: 'onsite' } }));
  delete process.env.GEMINI_API_KEY;
  store.writeApiKey(d, 'k-402');
  let agentCalls = 0;
  const runAgentFn = async () => { agentCalls++; return { ok: false, error: 'should not run' }; };
  const ep = await generateEpisode({ dataDir: d, date: '2026-10-15', deliver: false, buildSheets: false, log: () => {}, runAgentFn, fetchFn: geminiError(402, PREPAY, 'RESOURCE_EXHAUSTED'), readWorkbook: () => ({ questions: [] }) });
  assert.strictEqual(ep.status, 'failed');
  assert.strictEqual(ep.errorCode, 'billing');
  assert.match(ep.error, /ai\.studio\/projects/);
  assert.strictEqual(agentCalls, 0);
  assert.strictEqual(store.readKeyStatus(d).code, 'billing', 'the failed check is remembered for the dashboard');
});

test('the key can be inspected, replaced and removed from Job Quest without exposing it', async (t) => {
  delete process.env.GEMINI_API_KEY;
  const { d, call } = routeHarness(t, { fetchFn: audioFetch });

  assert.strictEqual((await call('GET', '/api/podcast')).body.key.source, 'none');
  await call('PUT', '/api/podcast/config', { apiKey: 'AIzaSy-first-9876' });
  let k = (await call('GET', '/api/podcast')).body.key;
  assert.strictEqual(k.verified, true);
  assert.strictEqual(k.source, 'file');
  assert.strictEqual(k.hint, '…9876');
  assert.ok(!JSON.stringify(k).includes('first'), 'the key itself never leaves the server');

  await call('PUT', '/api/podcast/config', { apiKey: 'AIzaSy-second-4321' });
  assert.strictEqual((await call('GET', '/api/podcast')).body.key.hint, '…4321');

  const gone = await call('DELETE', '/api/podcast/key');
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(gone.body.hasKey, false);
  assert.strictEqual(gone.body.key.code, 'no-key');
  assert.ok(!fs.existsSync(path.join(path.dirname(d), 'config', 'podcast-secrets.json')));
  assert.strictEqual((await call('POST', '/api/podcast/generate', { force: true })).status, 409);

  process.env.GEMINI_API_KEY = 'env-key-0000';
  try {
    assert.strictEqual((await call('GET', '/api/podcast')).body.key.source, 'env');
    const refused = await call('DELETE', '/api/podcast/key');
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /GEMINI_API_KEY/);
  } finally { delete process.env.GEMINI_API_KEY; }
});

test('the Daily Drop page has a voices card to replace, re-check and remove the key', () => {
  const jsx = fs.readFileSync(path.join(__dirname, '..', 'public', 'daily-drop.jsx'), 'utf-8');
  assert.match(jsx, /function VoicesCard/);
  assert.match(jsx, /Replace key/);
  assert.match(jsx, /Remove key/);
  assert.match(jsx, /req\('\/api\/podcast\/key', 'DELETE'\)/);
  assert.match(jsx, /key\.hint/);
});

test('the Daily Drop page shows the fix and gates the episode button on a verified key', () => {
  const jsx = fs.readFileSync(path.join(__dirname, '..', 'public', 'daily-drop.jsx'), 'utf-8');
  assert.match(jsx, /key\.remediation/);
  assert.match(jsx, /Check the key again/);
  assert.match(jsx, /\/api\/podcast\/key\/verify/);
  assert.ok(!/disabled=\{busy \|\| !info\.hasKey\}/.test(jsx), 'the first-episode button must gate on verification, not key presence');
  assert.match(jsx, /info\.key\.verified/);
  assert.match(jsx, /state\.key\.verified/);
});
