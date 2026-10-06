// app/tests/interview-server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { withServer: withTestServer } = require('./helpers/server');
const {
  makeEnv, copyFixtureSession, seedRole, installFakeAnalyst, withFakeAgent, FAKE_AGENT, ROLE_KEY, FIXTURE_FOLDER,
} = require('./helpers/interview-env');

async function withServer(env, fn) {
  try {
    await withTestServer(env.dataDir, fn, {
      HOME: env.root, INTERVIEW_HOME: env.interviewHome, JOB_QUEST_FAKE_AGENT: FAKE_AGENT,
    });
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
}

const get = async (url) => { const r = await fetch(url); return { code: r.status, body: await r.json() }; };
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { code: r.status, body: await r.json() };
};
async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function setup(t, opts) {
  const env = makeEnv(opts);
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  seedRole(env.dataDir, 'applied', { url: '' }); // no posting URL, so /api/interview/context never fetches over the network
  copyFixtureSession(env.interviewHome);
  installFakeAnalyst(env.dataDir);
  return env;
}

test('server startup avoids an occupied legacy random port', async (t) => {
  const decoy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ installed: false }));
  });
  let port;
  for (port = 4800; port < 5200; port++) {
    try {
      await new Promise((resolve, reject) => {
        decoy.once('error', reject);
        decoy.listen(port, resolve);
      });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    } finally {
      decoy.removeAllListeners('error');
    }
  }
  assert.ok(port < 5200, 'a legacy port is available for the decoy');
  t.mock.method(Math, 'random', () => (port - 4800) / 400);
  try {
    await withServer(setup(t), async (base) => {
      assert.equal((await get(`${base}/api/interview/status`)).body.installed, true);
    });
  } finally {
    await new Promise((resolve) => decoy.close(resolve));
  }
});

test('corrupt tracker sets lastError and successful re-ingest clears it', async (t) => {
  const env = setup(t);
  await withServer(env, async (base, logs) => {
    assert.equal((await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/link?wait=1`, { roleKey: ROLE_KEY })).body.status, 'ingested');
    const before = (await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`)).body;
    const trackerFile = path.join(env.dataDir, 'role-tracker.json');
    const tracker = fs.readFileSync(trackerFile, 'utf8');
    fs.writeFileSync(trackerFile, '{');
    assert.equal((await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest`)).body.status, 'started');
    const failed = await until(async () => {
      const { body } = await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`);
      return body.status === 'failed' && !body.ingesting ? body : null;
    });
    assert.match(failed.lastError, /Cannot ingest: failed to read .*role-tracker.json/);
    assert.equal(failed.analysisError, before.analysisError);
    assert.deepEqual(failed.analysis, before.analysis);
    assert.equal((await get(`${base}/api/interview/sessions`)).body[0].lastError, failed.lastError);
    assert.ok(logs().includes(failed.lastError));
    fs.writeFileSync(trackerFile, tracker);
    assert.equal((await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest?wait=1`)).body.status, 'ingested');
    assert.equal((await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`)).body.lastError, null);
    assert.equal((await get(`${base}/api/interview/sessions`)).body[0].lastError, null);
  });
});

test('failed ingest of a never-scanned folder logs without creating a stub record', async (t) => {
  const env = setup(t);
  await withServer(env, async (base, logs) => {
    await until(async () => (await get(`${base}/api/interview/sessions`)).body.length);
    const folder = '2020-01-01_0000';
    const dir = path.join(env.interviewHome, 'sessions', folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'session.json'), '{');
    const result = await post(`${base}/api/interview/sessions/${folder}/ingest?wait=1`);
    assert.equal(result.code, 400);
    assert.ok(logs().includes(`[interview] ${folder}: ${result.body.error}`));
    assert.equal(require('../lib/interview/records').readRecord(env.dataDir, folder), null);
    assert.equal((await get(`${base}/api/interview/sessions/${folder}`)).code, 404);
    assert.equal((await get(`${base}/api/interview/sessions`)).body.some((r) => r.folder === folder), false);
  });
});

test('startup scan records the unlinked session; status reports it', async (t) => {
  await withServer(setup(t), async (base) => {
    const unlinked = await until(async () => {
      const r = await get(`${base}/api/interview/sessions?status=unlinked`);
      return r.body.length ? r.body : null;
    });
    assert.equal(unlinked[0].folder, FIXTURE_FOLDER);
    assert.equal(unlinked[0].firstQuestion, 'Rate limiter: sliding window');
    assert.equal(unlinked[0].round, 'coding');
    const s = await get(`${base}/api/interview/status`);
    assert.equal(s.code, 200);
    assert.equal(s.body.installed, true);
    assert.equal(s.body.contract, 'jq-interview/1');
    assert.equal(s.body.repo, 'https://github.com/SideQuest-Collective/interview-copilot');
    assert.equal(s.body.sessions, 1);
    assert.equal(s.body.unlinked, 1);
  });
});

test('link ingests; role sessions, detail, and transcript render; re-ingest is unchanged', async (t) => {
  await withServer(setup(t), async (base) => {
    const linked = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/link?wait=1`, { roleKey: ROLE_KEY });
    assert.equal(linked.code, 200);
    assert.equal(linked.body.status, 'ingested');
    const list = await get(`${base}/api/interview/sessions?roleKey=${encodeURIComponent(ROLE_KEY)}`);
    assert.equal(list.body.length, 1);
    assert.deepEqual(list.body[0].effects, { timeline: 1, stage: { from: 'applied', to: 'onsite' }, questionsAdded: 2, tasks: 2, grades: 2 });
    assert.equal(list.body[0].interviewer, 'Alex');
    assert.equal(list.body[0].durationMin, 45);
    const detail = await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`);
    assert.ok(detail.body.debriefMarkdown.includes('## Scorecard'));
    assert.equal(detail.body.analysis.asked.length, 2);
    const tr = await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/transcript`);
    assert.ok(tr.body.markdown.includes('**Interviewer** (15:14:00): Thanks. Both approaches are clear; add a nested-interval example to your tests.'));
    const again = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest?wait=1`);
    assert.equal(again.body.status, 'unchanged');
    const bg = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest`);
    assert.deepEqual(bg.body, { status: 'started', folder: FIXTURE_FOLDER });
    await until(async () => !(await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`)).body.ingesting);
  });
});

test('rejects traversal in :folder and unknown folders', async (t) => {
  await withServer(setup(t), async (base) => {
    for (const bad of ['..%2F..%2Fetc', '%2Fetc%2Fpasswd', '.hidden', 'a..b']) {
      assert.equal((await get(`${base}/api/interview/sessions/${bad}`)).code, 400, bad);
      assert.equal((await get(`${base}/api/interview/sessions/${bad}/transcript`)).code, 400, bad);
      assert.equal((await post(`${base}/api/interview/sessions/${bad}/link`, { roleKey: ROLE_KEY })).code, 400, bad);
      assert.equal((await post(`${base}/api/interview/sessions/${bad}/ingest`)).code, 400, bad);
    }
    assert.equal((await get(`${base}/api/interview/sessions/2020-01-01_0000`)).code, 404);
    assert.equal((await post(`${base}/api/interview/sessions/2020-01-01_0000/link`, { roleKey: ROLE_KEY })).code, 404);
    assert.equal((await get(`${base}/api/interview/sessions/2020-01-01_0000/transcript`)).code, 404);
    assert.equal((await post(`${base}/api/interview/sessions/2020-01-01_0000/ingest`)).code, 404);
  });
});

test('link and context validate their input', async (t) => {
  await withServer(setup(t), async (base) => {
    const bad = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/link`, { roleKey: 'Nobody|Role' });
    assert.equal(bad.code, 400);
    assert.match(bad.body.error, /unknown roleKey/);
    assert.equal((await post(`${base}/api/interview/context`, {})).code, 400);
    assert.equal((await post(`${base}/api/interview/context`, { roleKey: ROLE_KEY, round: 'lunch' })).code, 400);
    const ok = await post(`${base}/api/interview/context`, { roleKey: ROLE_KEY, round: 'coding' });
    assert.equal(ok.code, 200);
    assert.deepEqual(Object.keys(ok.body), ['written', 'skipped', 'cheatsheet', 'practice']);
  });
});

test('status reports not installed when capture.py is absent', async (t) => {
  await withServer(setup(t, { installed: false }), async (base) => {
    assert.equal((await get(`${base}/api/interview/status`)).body.installed, false);
  });
});

test('wait preserves ingest error codes; background failures are logged and pollable', async (t) => {
  const env = setup(t);
  await withServer(env, async (base, logs) => {
    await until(async () => (await get(`${base}/api/interview/sessions`)).body.length);
    const file = path.join(env.interviewHome, 'sessions', FIXTURE_FOLDER, 'session.json');
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...session, contractVersion: 'jq-interview/99' }));
    const conflict = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest?wait=1`);
    assert.equal(conflict.code, 409);
    assert.deepEqual(Object.keys(conflict.body), ['error']);
    assert.match(conflict.body.error, /contract mismatch/);
    const bg = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/link`, { roleKey: ROLE_KEY });
    assert.deepEqual(bg.body, { status: 'linking', folder: FIXTURE_FOLDER, roleKey: ROLE_KEY });
    const failed = await until(async () => {
      const { body } = await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`);
      return body.status === 'failed' && !body.ingesting ? body : null;
    });
    assert.equal(failed.link.roleKey, ROLE_KEY);
    assert.match(failed.lastError, /contract mismatch/);
    assert.equal(failed.analysisError, null);
    assert.match(logs(), /\[interview\].*contract mismatch/);
    fs.writeFileSync(file, '{');
    assert.equal((await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest?wait=true`)).code, 400);
    fs.writeFileSync(file, JSON.stringify(session));
    const recovered = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest?wait=1`);
    assert.equal(recovered.body.status, 'ingested');
    const trackerFile = path.join(env.dataDir, 'role-tracker.json');
    const tracker = fs.readFileSync(trackerFile, 'utf8');
    fs.writeFileSync(trackerFile, '{');
    const unexpected = await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest?wait=1`);
    assert.equal(unexpected.code, 500);
    assert.deepEqual(Object.keys(unexpected.body), ['error']);
    assert.match(unexpected.body.error, /failed to read/);
    assert.doesNotMatch(unexpected.body.error, /\n\s+at /);
    fs.writeFileSync(trackerFile, tracker);
    assert.equal((await post(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/ingest?wait=1`)).body.status, 'ingested');
    const repaired = await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`);
    assert.equal(repaired.body.analysisError, null);
    assert.equal(repaired.body.ingesting, false);
  });
});

test('summary preserves every record status separately from the in-flight flag and returns raw markdown', async (t) => {
  const env = setup(t);
  await withServer(env, async (base) => {
    await until(async () => (await get(`${base}/api/interview/sessions`)).body.length);
    const records = require('../lib/interview/records');
    for (const status of ['unlinked', 'linking', 'ingesting', 'failed', 'ingested']) {
      records.writeRecord(env.dataDir, { folder: `test-${status}`, status, roleKey: ROLE_KEY, analysisError: status === 'failed' ? 'failure' : null });
      const { body } = await get(`${base}/api/interview/sessions?status=${status}&roleKey=${encodeURIComponent(ROLE_KEY)}`);
      assert.equal(body.length, 1);
      assert.equal(body[0].status, status);
      assert.equal(body[0].ingesting, false);
    }
    const raw = '# Heading\n<script>alert("raw")</script>\n';
    const dir = path.join(env.interviewHome, 'sessions', FIXTURE_FOLDER);
    fs.writeFileSync(path.join(dir, 'debrief.md'), raw);
    fs.writeFileSync(path.join(dir, 'transcript.md'), raw);
    assert.equal((await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}`)).body.debriefMarkdown, raw);
    assert.equal((await get(`${base}/api/interview/sessions/${FIXTURE_FOLDER}/transcript`)).body.markdown, raw);
  });
});

test('HTTP errors map real ingest codes and busy lock messages', () => {
  const { httpStatus } = require('../lib/interview/routes');
  const { InputError, NotFoundError, ContractError } = require('../lib/interview/contract');
  assert.equal(httpStatus(new InputError('input')), 400);
  assert.equal(httpStatus(new NotFoundError('missing')), 404);
  assert.equal(httpStatus(new ContractError('contract')), 409);
  assert.equal(httpStatus(new Error('busy: another ingest of session is running')), 409);
  assert.equal(httpStatus(new Error('unexpected')), 500);
});


test('unchanged ingest route does not rewrite the session record', async (t) => {
  const env = setup(t);
  const records = require('../lib/interview/records');
  const routes = new Map();
  const app = { get() {}, post(route, fn) { routes.set(route, fn); } };
  require('../lib/interview/routes').registerInterviewRoutes(app, env);
  await require('../lib/interview/ingest').ingestSession({ ...env, folder: FIXTURE_FOLDER });
  const writer = t.mock.method(records, 'writeRecord');
  let result;
  await routes.get('/api/interview/sessions/:folder/ingest')(
    { params: { folder: FIXTURE_FOLDER }, query: { wait: '1' } },
    { json(body) { result = body; }, status(code) { assert.fail(`unexpected HTTP ${code}`); } },
  );
  assert.equal(result.status, 'unlinked');
  assert.equal(writer.mock.calls.length, 0);
});

test('ingest route rejects a symlink immediately without wait=1', async (t) => {
  const env = setup(t);
  const alias = 'session-alias';
  fs.symlinkSync(path.join(env.interviewHome, 'sessions', FIXTURE_FOLDER),
    path.join(env.interviewHome, 'sessions', alias));
  const routes = new Map();
  const app = { get() {}, post(route, fn) { routes.set(route, fn); } };
  const api = require('../lib/interview/routes').registerInterviewRoutes(app, env);
  t.mock.method(console, 'error', () => {});
  let code = 200;
  let result;
  const response = { json(body) { result = body; }, status(value) { code = value; return this; } };
  await routes.get('/api/interview/sessions/:folder/ingest')(
    { params: { folder: alias }, query: {} }, response,
  );
  await Promise.allSettled(api.inflight.values());
  assert.equal(code, 400);
  assert.match(result.error, /session folder must not be a symlink/);
  assert.equal(require('../lib/interview/records').readRecord(env.dataDir, alias), null);
});

test('context route accepts an empty round and a role containing another separator', async (t) => {
  const env = setup(t);
  const roleKey = 'Acme Capital|Software Engineer | Platform';
  fs.writeFileSync(path.join(env.dataDir, 'role-tracker.json'), JSON.stringify({
    [roleKey]: { stage: 'applied', url: '' },
  }));
  const routes = new Map();
  const app = { get() {}, post(route, fn) { routes.set(route, fn); } };
  require('../lib/interview/routes').registerInterviewRoutes(app, env);
  let code = 200;
  let result;
  const response = { json(body) { result = body; }, status(value) { code = value; return this; } };
  await routes.get('/api/interview/context')({ body: { roleKey, round: '' } }, response);
  assert.equal(code, 200);
  assert.equal(result.practice, null);
  const target = path.join(env.interviewHome, 'context', 'target.md');
  assert.ok(result.written.includes(target));
  assert.match(fs.readFileSync(target, 'utf8'), /Software Engineer \| Platform/);
});

test('link route accepts a role containing another separator', async (t) => {
  withFakeAgent(t);
  const env = setup(t);
  const roleKey = 'Acme Capital|Software Engineer | Platform';
  fs.writeFileSync(path.join(env.dataDir, 'role-tracker.json'), JSON.stringify({
    [roleKey]: { stage: 'applied', url: '' },
  }));
  const routes = new Map();
  const app = { get() {}, post(route, fn) { routes.set(route, fn); } };
  require('../lib/interview/routes').registerInterviewRoutes(app, env);
  let code = 200;
  let result;
  const response = { json(body) { result = body; }, status(value) { code = value; return this; } };
  await routes.get('/api/interview/sessions/:folder/link')({
    params: { folder: FIXTURE_FOLDER }, query: { wait: '1' }, body: { roleKey },
  }, response);
  assert.equal(code, 200);
  assert.equal(result.status, 'ingested');
  const record = require('../lib/interview/records').readRecord(env.dataDir, FIXTURE_FOLDER);
  assert.equal(record.roleKey, roleKey);
  assert.equal(record.link.roleKey, roleKey);
});
