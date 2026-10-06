// app/tests/workbook-api.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const store = require('../lib/workbook/store');
const { buildExportHtml } = require('../lib/workbook/export');
const { writeKit } = require('./helpers/workbook-fixture');

const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-api-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(dataDir, fn) {
  const port = 5100 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, INTERVIEW_HOME: path.join(dataDir, 'no-interview'), PORT: String(port), JOB_QUEST_FAKE_AGENT: FAKE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      try { if ((await fetch(`${base}/api/workbooks`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`server did not start\n${stderr}`);
      await sleep(100);
    }
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 1000); });
  }
}

function call(base, url, method = 'GET', body) {
  return fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

function seedReady(dataDir, roleKey = 'Acme|Staff Engineer', extra = {}) {
  const meta = store.createWorkbook(dataDir, { roleKeys: [roleKey], status: 'ready', ...extra });
  writeKit(store.wbDir(dataDir, meta.id));
  return meta;
}

test('fix round 3: listItem exposes unreviewed chapters and defaults older metadata to zero', (t) => {
  const { registerWorkbookRoutes } = require('../lib/workbook/routes');
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = seedReady(dir);
  const queue = { list: () => [] };
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, fn) => routes.set(`${method} ${url}`, fn)]));
  registerWorkbookRoutes(app, { dataDir: dir, queue, autoBuild: {}, publicDir: path.join(__dirname, '..', 'public') });
  const res = { json(body) { this.body = body; } };
  routes.get('get /api/workbooks')({ query: {} }, res);
  assert.equal(res.body[0].unreviewedChapters, 0);
  store.writeMeta(dir, { ...meta, unreviewedChapters: 5 });
  routes.get('get /api/workbooks')({ query: {} }, res);
  assert.equal(res.body[0].unreviewedChapters, 5);
});

async function waitForJob(base, id) {
  for (let i = 0; i < 100; i++) {
    const j = await (await call(base, `/api/workbooks/${id}/job`)).json();
    if (j.queue && (j.queue.status === 'done' || j.queue.status === 'failed')) return j;
    await sleep(100);
  }
  throw new Error(`job for ${id} did not finish`);
}

test('buildExportHtml inlines escaped data and refuses a template without the marker', () => {
  const out = buildExportHtml('<body><!--WB-DATA--></body>', { meta: { title: 'a </script> b' } });
  assert.match(out, /<script>window\.WB_OFFLINE=true;<\/script>/);
  assert.doesNotMatch(out, /a <\/script> b/);
  assert.equal((out.match(/<script type="application\/json" id="wb-data">/g) || []).length, 1);
  assert.doesNotMatch(out, /<!--WB-DATA-->/);
  assert.deepEqual(JSON.parse(out.match(/id="wb-data">([\s\S]*?)<\/script>/)[1]), { meta: { title: 'a </script> b' } });
  assert.throws(() => buildExportHtml('<body></body>', {}), /WB-DATA/);
});

test('create is idempotent and the list carries readiness and the job', async () => {
  await withServer(tmp(), async (base) => {
    const first = await call(base, '/api/workbooks', 'POST', { roleKey: 'Beta|Senior SWE' });
    assert.equal(first.status, 201);
    const a = await first.json();
    assert.deepEqual([a.status, a.workbook.id], ['queued', 'beta-senior-swe']);
    const second = await call(base, '/api/workbooks', 'POST', { roleKey: 'Beta|Senior SWE' });
    assert.equal(second.status, 200);
    const b = await second.json();
    assert.deepEqual([b.status, b.workbook.id], ['exists', 'beta-senior-swe']);
    assert.equal((await call(base, '/api/workbooks', 'POST', { roleKey: 'no pipe' })).status, 400);
    const list = await (await call(base, '/api/workbooks')).json();
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].id, list[0].readiness, list[0].total], ['beta-senior-swe', 0, 0]);
    assert.ok(list[0].job);
    assert.ok((await waitForJob(base, a.workbook.id)).state);
  });
});

test('content, progress merge, export, and the viewer route', async () => {
  const dir = tmp();
  const meta = seedReady(dir);
  await withServer(dir, async (base) => {
    const content = await (await call(base, `/api/workbooks/${meta.id}/content`)).json();
    assert.equal(content.meta.id, meta.id);
    assert.deepEqual([content.content.chapters.length, content.content.questions.length, content.content.glossary.length], [2, 3, 4]);
    assert.equal(content.content.questions[1].sdTopicId, store.sdTopicId(meta.id, 'intro-2'));
    const put = await call(base, `/api/workbooks/${meta.id}/progress`, 'PUT', { grades: { 'intro-1': { grade: 'got', at: '2026-10-05T10:00:00.000Z' } }, answers: { 'intro-2': 'fan out' } });
    assert.equal(put.status, 200);
    await call(base, `/api/workbooks/${meta.id}/progress`, 'PUT', { grades: { 'intro-1': { grade: 'missed', at: '2026-10-04T10:00:00.000Z' } } });
    const p = await (await call(base, `/api/workbooks/${meta.id}/progress`)).json();
    assert.equal(p.grades['intro-1'].grade, 'got');
    assert.equal(p.history['intro-1'].length, 2);
    assert.equal(p.answers['intro-2'], 'fan out');
    const [item] = await (await call(base, '/api/workbooks')).json();
    assert.deepEqual([item.readiness, item.graded, item.total, item.misses, item.failedChapters], [17, 1, 3, 0, 0]);
    const exp = await fetch(`${base}/api/workbooks/${meta.id}/export`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-type'), /text\/html/);
    assert.match(exp.headers.get('content-disposition'), /attachment; filename="acme-staff-engineer\.html"/);
    const html = await exp.text();
    assert.match(html, /window\.WB_OFFLINE=true/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
    const data = JSON.parse(html.match(/<script type="application\/json" id="wb-data">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data.content.questions.length, 3);
    assert.equal(data.progress.grades['intro-1'].grade, 'got');
    const viewer = await fetch(`${base}/workbooks/${meta.id}`);
    assert.equal(viewer.status, 200);
    assert.match(await viewer.text(), /<!--WB-DATA-->/);
    assert.equal((await fetch(`${base}/workbooks/nope`)).status, 404);
  });
});

test('crafted ids are rejected with 404', async () => {
  const dir = tmp();
  seedReady(dir);
  await withServer(dir, async (base) => {
    // Raw HTTP preserves encoded dot segments that fetch would normalize away.
    const rawStatus = (url, method) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: new URL(base).port, path: url, method }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    for (const bad of ['..%2F..', '..%2F..%2Fsettings', '..%2Fjobs', '%2E%2E', 'ACME', 'a'.repeat(95), 'x%00y', 'missing']) {
      for (const [method, suffix] of [['GET', ''], ['GET', '/job'], ['GET', '/content'], ['GET', '/progress'], ['PUT', '/progress'], ['POST', '/expand'], ['POST', '/retry'], ['GET', '/export'], ['DELETE', '']]) {
        assert.equal(await rawStatus(`/api/workbooks/${bad}${suffix}`, method), 404, `${method} ${bad}${suffix}`);
      }
      assert.equal(await rawStatus(`/workbooks/${bad}`, 'GET'), 404, bad);
    }
    assert.equal(fs.existsSync(path.join(dir, 'settings', 'progress.json')), false);
  });
});

test('expand, retry, and delete guard their preconditions', async () => {
  const dir = tmp();
  const ready = seedReady(dir);
  const onsite = seedReady(dir, 'Gamma|Eng', { tier: 'onsite' });
  const queued = store.createWorkbook(dir, { roleKeys: ['Delta|Eng'] });
  await withServer(dir, async (base) => {
    assert.equal((await call(base, `/api/workbooks/${onsite.id}/expand`, 'POST')).status, 409);
    assert.equal((await call(base, `/api/workbooks/${queued.id}/expand`, 'POST')).status, 409);
    assert.equal((await call(base, `/api/workbooks/${ready.id}/retry`, 'POST')).status, 409);
    const ex = await call(base, `/api/workbooks/${ready.id}/expand`, 'POST');
    assert.equal(ex.status, 202);
    assert.equal((await ex.json()).status, 'queued');
    await waitForJob(base, ready.id);
    assert.equal(store.readMeta(dir, ready.id).status, 'ready');
    assert.equal((await call(base, `/api/workbooks/${ready.id}`, 'DELETE')).status, 200);
    assert.equal((await call(base, `/api/workbooks/${ready.id}`)).status, 404);
  });
});

test('saving a role through role-actions auto-builds exactly one workbook', async () => {
  await withServer(tmp(), async (base) => {
    const body = { saved: ['Beta|Senior SWE'], skipped: [], applied: [] };
    await call(base, '/api/role-actions', 'POST', body);
    await call(base, '/api/role-actions', 'POST', body);
    await call(base, '/api/role-actions', 'POST', { ...body, applied: ['Beta|Senior SWE'] });
    const list = await (await call(base, '/api/workbooks')).json();
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].roleKeys, list[0].trigger], [['Beta|Senior SWE'], 'auto-saved']);
    assert.deepEqual((await (await call(base, '/api/workbooks/backfill')).json()).candidates, []);
  });
});

test('idle retry starts generating without a stale queued overwrite and blocks deletion', async () => {
  const dir = tmp();
  const meta = store.createWorkbook(dir, { roleKeys: ['Retry|Eng'], status: 'failed' });
  const fakeDir = path.join(store.wbDir(dir, meta.id), '.fake');
  fs.mkdirSync(fakeDir);
  fs.writeFileSync(path.join(fakeDir, 'researcher.js'), 'module.exports = async () => new Promise(r => setTimeout(r, 400));');
  await withServer(dir, async (base) => {
    const retry = await call(base, `/api/workbooks/${meta.id}/retry`, 'POST');
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).status, 'queued');
    const job = await (await call(base, `/api/workbooks/${meta.id}/job`)).json();
    assert.equal(job.queue.status, 'running');
    assert.equal(job.queue.mode, 'create');
    assert.equal(store.readMeta(dir, meta.id).status, 'generating');
    assert.equal((await call(base, `/api/workbooks/${meta.id}`, 'DELETE')).status, 409);
    await waitForJob(base, meta.id);
  });
});

test('auto-save and backfill persist deferred status from the enqueue result', async () => {
  const dir = tmp();
  await withServer(dir, async (base) => {
    await call(base, '/api/settings', 'PUT', { workbooks: { autoDailyCap: 0 } });
    await call(base, '/api/role-actions', 'POST', { saved: ['Deferred|Eng'], applied: [], skipped: [] });
    assert.equal(store.findByRoleKey(dir, 'Deferred|Eng').status, 'deferred');
    await call(base, '/api/settings', 'PUT', { workbooks: { autoBuild: false } });
    await call(base, '/api/role-actions', 'POST', { saved: ['Deferred|Eng', 'Backfill|Eng'], applied: [], skipped: [] });
    assert.deepEqual((await (await call(base, '/api/workbooks/backfill')).json()).candidates, ['Backfill|Eng']);
    const response = await call(base, '/api/workbooks/backfill', 'POST');
    assert.equal(response.status, 200);
    const { results } = await response.json();
    assert.deepEqual(results.map(r => [r.status, r.workbook.status]), [['deferred', 'deferred']]);
    const list = await (await call(base, '/api/workbooks')).json();
    assert.ok(list.every(w => w.status === 'deferred' && w.job.status === 'deferred'));
  });
});

test('onsite creation queues create then expand', async () => {
  const dir = tmp();
  const meta = store.createMinimal(dir, { roleKey: 'Onsite|Eng' });
  const fakeDir = path.join(store.wbDir(dir, meta.id), '.fake');
  fs.mkdirSync(fakeDir);
  fs.writeFileSync(path.join(fakeDir, 'researcher.js'), 'module.exports = async () => new Promise(r => setTimeout(r, 400));');
  await withServer(dir, async (base) => {
    const res = await call(base, '/api/workbooks', 'POST', { roleKey: 'Onsite|Eng', tier: 'onsite' });
    assert.equal(res.status, 201);
    const { workbook } = await res.json();
    const jobs = await (await call(base, '/api/jobs')).json();
    assert.deepEqual(jobs.filter(j => j.payload.workbookId === workbook.id).map(j => j.payload.mode), ['create', 'expand']);
    const state = await (await call(base, `/api/workbooks/${workbook.id}/job`)).json();
    assert.equal(state.state.status, 'running');
    assert.equal(store.readMeta(dir, workbook.id).status, 'generating');
    assert.ok(state.queue);
    await waitForJob(base, workbook.id);
  });
});

test('duplicate expansion, retry, and interview conversion preserve the prior status', async () => {
  const dir = tmp();
  const expand = seedReady(dir, 'Expand duplicate|Eng');
  const retry = seedReady(dir, 'Retry duplicate|Eng', { status: 'partial' });
  store.writeJob(dir, retry.id, { chapters: { failed: { status: 'failed' } } });
  const interview = store.createMinimal(dir, { roleKey: 'Interview duplicate|Eng' });
  const jobs = [[expand, 'expand'], [retry, 'retry'], [interview, 'create']].map(([meta, mode]) => ({
    id: `duplicate-${mode}`, kind: 'workbook', key: `workbook:${meta.id}${mode === 'create' ? '' : ':' + mode}`,
    payload: { workbookId: meta.id, mode }, status: 'deferred', createdAt: '2026-10-05T00:00:00.000Z',
    cap: { name: 'workbooks', limit: 0 },
  }));
  store.writeJsonAtomic(path.join(dir, 'jobs', 'queue.json'), { jobs, counts: {} });
  await withServer(dir, async (base) => {
    for (const [meta, mode] of [[expand, 'expand'], [retry, 'retry']]) {
      const res = await call(base, `/api/workbooks/${meta.id}/${mode}`, 'POST');
      assert.equal(res.status, 202);
      assert.equal((await res.json()).status, 'duplicate');
      assert.equal(store.readMeta(dir, meta.id).status, meta.status);
    }
    const res = await call(base, '/api/workbooks', 'POST', { roleKey: 'Interview duplicate|Eng' });
    assert.equal((await res.json()).status, 'duplicate');
    assert.equal(store.readMeta(dir, interview.id).status, interview.status);
    assert.equal((await (await call(base, '/api/jobs')).json()).length, 3);
  });
});

test('expand and failed-chapter retry persist queued status before an idle handler runs', async () => {
  const { createQueue } = require('../lib/jobs/queue');
  const { registerWorkbookRoutes } = require('../lib/workbook/routes');
  for (const mode of ['expand', 'retry']) {
    const dir = tmp();
    const meta = seedReady(dir, `${mode}|Eng`, { status: 'partial' });
    if (mode === 'retry') store.writeJob(dir, meta.id, { chapters: { broken: { status: 'failed' } } });
    let observed;
    const queue = createQueue({ dataDir: dir, handlers: { workbook: async (job) => {
      observed = [job.payload.mode, store.readMeta(dir, meta.id).status];
      store.writeMeta(dir, { ...meta, status: 'generating' });
    } } });
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, fn) => routes.set(`${method} ${url}`, fn)]));
    registerWorkbookRoutes(app, { dataDir: dir, queue, autoBuild: {}, publicDir: path.join(__dirname, '..', 'public') });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    routes.get(`post /api/workbooks/:id/${mode}`)({ params: { id: meta.id } }, res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.status, 'queued');
    assert.deepEqual(observed, [mode, 'queued']);
    assert.equal(store.readMeta(dir, meta.id).status, 'generating');
    await queue.drain();
  }
});

for (const status of ['queued', 'deferred']) {
  test(`delete refuses a workbook with a ${status} job`, async () => {
    const { createQueue } = require('../lib/jobs/queue');
    const { registerWorkbookRoutes } = require('../lib/workbook/routes');
    const dir = tmp();
    const meta = seedReady(dir);
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const queue = createQueue({ dataDir: dir, handlers: { workbook: () => blocked } });
    if (status === 'queued') queue.enqueue({ kind: 'workbook', key: 'blocker' });
    const job = queue.enqueue({ kind: 'workbook', key: `workbook:${meta.id}`, payload: { workbookId: meta.id, mode: 'create' } },
      status === 'deferred' ? { auto: true, capName: 'workbooks', cap: 0 } : {});
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, fn) => routes.set(`${method} ${url}`, fn)]));
    registerWorkbookRoutes(app, { dataDir: dir, queue, autoBuild: {}, publicDir: path.join(__dirname, '..', 'public') });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    try {
      assert.equal(queue.get(job.id).status, status);
      routes.get('delete /api/workbooks/:id')({ params: { id: meta.id } }, res);
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.body, { error: 'this workbook is being generated; try again when it finishes' });
      assert.deepEqual(store.readMeta(dir, meta.id), meta);
      assert.equal(queue.get(job.id).status, status);
    } finally {
      release();
      await queue.drain();
    }
  });
}

test('workbook viewer page loads when the app lives under a dot directory like ~/.job-quest', async (t) => {
  const express = require('express');
  const { registerWorkbookRoutes } = require('../lib/workbook/routes');
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const publicDir = path.join(dir, '.job-quest', 'app', 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'workbook.html'), path.join(publicDir, 'workbook.html'));
  const meta = seedReady(dir);
  const app = express();
  registerWorkbookRoutes(app, { dataDir: dir, queue: { list: () => [] }, autoBuild: {}, publicDir });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await fetch(`${base}/workbooks/${meta.id}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/html/);
  assert.match(await ok.text(), /<html/i);
  assert.equal((await fetch(`${base}/workbooks/missing-id`)).status, 404);
});

test('create accepts research the caller already gathered, keeps it through the build, and validates it', async () => {
  const dir = tmp();
  const research = '## Role summary\n\n- Reported screen: spreadsheet engine.\n\n## Sources\n\n- [Report](https://example.com/report)\n';
  await withServer(dir, async (base) => {
    const bad = await call(base, '/api/workbooks', 'POST', { roleKey: 'Gamma|SWE', research: '## Notes\n\nno sources' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /## Sources/);
    assert.equal(fs.existsSync(path.join(dir, 'workbooks', 'gamma-swe')), false);
    const r = await call(base, '/api/workbooks', 'POST', { roleKey: 'Gamma|SWE', research });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.workbook.researched, true);
    assert.equal(body.workbook.researchSource, 'supplied');
    await waitForJob(base, body.workbook.id);
    assert.equal(fs.readFileSync(path.join(dir, 'workbooks', 'gamma-swe', 'research.md'), 'utf-8'), research);
    const again = await (await call(base, '/api/workbooks', 'POST', { roleKey: 'Gamma|SWE', research })).json();
    assert.deepEqual([again.status, again.researchIgnored], ['exists', true]);
  });
});
