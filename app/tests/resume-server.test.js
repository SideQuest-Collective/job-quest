// app/tests/resume-server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withServer, post, put } = require('./helpers/server');
const { loadMaster, tmpDir } = require('./helpers/resume-fixtures');

const ROLE = 'Initech|Senior Software Engineer';

// Isolate startup races without relying on actual port collisions or shared mocks.
function startupHarness(onSpawn) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const calls = { reservations: [], children: [], probes: [] };
  const net = { createServer() {
    const reservation = new EventEmitter();
    const entry = { port: 32000 + calls.reservations.length, closed: false };
    calls.reservations.push(entry);
    reservation.listen = (port, ...args) => {
      entry.requestedPort = port;
      process.nextTick(() => { reservation.emit('listening'); args.find(a => typeof a === 'function')?.(); });
      return reservation;
    };
    reservation.address = () => ({ port: entry.port });
    reservation.close = (cb) => { entry.closed = true; process.nextTick(cb); };
    return reservation;
  } };
  const childProcess = { spawn(command, args, options) {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); };
    child.finish = () => { child.exitCode = 0; child.emit('exit', 0, null); };
    child.banner = () => child.stdout.write(`  http://localhost:${options.env.PORT}\n`);
    calls.children.push({ child, port: Number(options.env.PORT), home: options.env.HOME,
      reservationClosed: calls.reservations.at(-1)?.closed });
    process.nextTick(() => onSpawn(child, calls.children.length, calls));
    return child;
  } };
  const module = { exports: {} };
  const filename = path.join(__dirname, 'helpers/server.js');
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), process, setTimeout, clearTimeout, AbortSignal,
    require: (id) => id === 'node:net' ? net : id === 'node:child_process' ? childProcess : require(id),
    fetch: async (url) => {
      calls.probes.push(url);
      await new Promise(resolve => setImmediate(resolve));
      return { ok: true };
    },
  }, { filename });
  return { withServer: module.exports.withServer, calls };
}

test('server helper reserves port zero and closes the reservation before spawning', async () => {
  const harness = startupHarness(child => child.banner());
  await harness.withServer('/unused', async base => {
    assert.equal(harness.calls.reservations.length, 1);
    const reservation = harness.calls.reservations[0];
    assert.equal(reservation.requestedPort, 0);
    assert.equal(reservation.closed, true);
    assert.equal(harness.calls.children[0].reservationClosed, true);
    assert.equal(base, `http://127.0.0.1:${reservation.port}`);
  });
  assert.ok(harness.calls.children.every(({ home }) => !fs.existsSync(home)));
});

test('server helper retries early exits up to three times with fresh ports', async () => {
  const harness = startupHarness((child, attempt) => attempt < 4 ? child.finish() : child.banner());
  let callbacks = 0;
  await harness.withServer('/unused', async () => { callbacks++; });
  assert.equal(callbacks, 1);
  assert.equal(harness.calls.children.length, 4);
  assert.equal(new Set(harness.calls.children.map(c => c.port)).size, 4);
  assert.ok(harness.calls.children.every(({ home }) => !fs.existsSync(home)));
});

test('server helper stops after three startup retries', async () => {
  const harness = startupHarness(child => child.finish());
  await assert.rejects(harness.withServer('/unused', async () => assert.fail('exited child is not ready')), /server exited with 0/);
  assert.equal(harness.calls.children.length, 4);
  assert.ok(harness.calls.children.every(({ home }) => !fs.existsSync(home)));
});

test('server helper waits for this child port banner before accepting a healthy probe', async () => {
  let bannerSent = false;
  let timer;
  const harness = startupHarness(child => {
    child.stdout.write('  http://localhost:1\n');
    timer = setTimeout(() => { bannerSent = true; child.banner(); }, 150);
  });
  try {
    await harness.withServer('/unused', async () => {
      assert.equal(bannerSent, true, 'a sibling HTTP response must not satisfy readiness');
      assert.ok(harness.calls.probes.length > 0);
    });
  } finally { clearTimeout(timer); }
});

for (const route of ['compile', 'edit', 'delete']) {
  for (const filename of ['../escape.tex', '../resume-files-x/escape.tex']) {
    test(`resume ${route} rejects external path ${filename}`, async () => {
      const dir = tmpDir();
      const outside = path.resolve(dir, 'resume-files', filename);
      // Missing compile/edit targets avoid launching real tools before the fix.
      // DELETE gets a real sentinel to prove it cannot remove an outside file.
      if (route === 'delete') {
        fs.mkdirSync(path.dirname(outside), { recursive: true });
        fs.writeFileSync(outside, 'outside sentinel');
      }
      await withServer(dir, async (base) => {
        const response = route === 'delete'
          ? await fetch(`${base}/api/resume/file/${encodeURIComponent(filename)}`, { method: 'DELETE' })
          : await fetch(`${base}/api/resume/${route}`, post({ mainFile: filename, filename, instruction: 'Keep content unchanged.' }));
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'Invalid resume path' });
        if (route === 'delete') assert.equal(fs.readFileSync(outside, 'utf8'), 'outside sentinel');
      });
    });
  }
}

test('resume guarded routes still accept nested paths', async () => {
  const dir = tmpDir();
  await withServer(dir, async (base) => {
    for (const route of ['compile', 'edit']) {
      const response = await fetch(`${base}/api/resume/${route}`, post({
        mainFile: 'nested/missing.tex', filename: 'nested/missing.tex', instruction: 'Keep content unchanged.',
      }));
      assert.equal(response.status, 404, route);
    }
    const filename = 'nested/valid.tex';
    assert.equal((await fetch(`${base}/api/resume/create-file`, post({ filename, content: 'valid' }))).status, 200);
    assert.equal((await fetch(`${base}/api/resume/file/${filename}`, { method: 'DELETE' })).status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'resume-files', filename)), false);
  });
});

function seedIntel(dir, roles) {
  fs.mkdirSync(path.join(dir, 'intel'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'intel', '2026-10-05.json'), JSON.stringify({ roles }));
}

async function waitFor(base, id, pred) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const r = await (await fetch(`${base}/api/resume/tailored/${id}`)).json();
    if (pred(r.meta)) return r;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${JSON.stringify(r.meta)}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

test('master GET/PUT round trip with validation errors', async () => {
  await withServer(tmpDir(), async (base) => {
    const empty = await (await fetch(`${base}/api/resume/master`)).json();
    assert.equal(empty.version, 1);
    assert.deepEqual(empty.experience, []);
    const bad = loadMaster();
    bad.experience[0].start = '2017/06';
    const r1 = await fetch(`${base}/api/resume/master`, put(bad));
    assert.equal(r1.status, 400);
    assert.ok((await r1.json()).errors.some((e) => e.startsWith('experience[0].start')));
    const m = loadMaster();
    m.experience[0].roles[0].bullets.push({ text: 'Added from the UI for 2 teams.' });
    const r2 = await fetch(`${base}/api/resume/master`, put(m));
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).experience[0].roles[0].bullets[5].id, 'exp.sr.6');
  });
});

test('tailored lifecycle over HTTP: create, fail fast without a URL, 400/404/409s, delete', async () => {
  const dir = tmpDir();
  seedIntel(dir, [{ company: 'Initech', role: 'Senior Software Engineer' }]);
  await withServer(dir, async (base) => {
    assert.equal((await fetch(`${base}/api/resume/tailored`, post({}))).status, 400);
    const created = await fetch(`${base}/api/resume/tailored`, post({ roleKey: ROLE }));
    assert.equal(created.status, 201);
    const { meta } = await created.json();
    const rec = await waitFor(base, meta.id, (m) => m.status === 'failed');
    assert.equal(rec.meta.error, 'posting unavailable: no posting URL. Paste the job description to continue.');
    assert.equal((await fetch(`${base}/api/resume/tailored/${meta.id}/jd`, put({ text: 'short' }))).status, 400);
    assert.equal((await fetch(`${base}/api/resume/tailored/${meta.id}/pdf`)).status, 404);
    assert.equal((await fetch(`${base}/api/resume/tailored/${meta.id}/accept`, post({}))).status, 409);
    assert.equal((await fetch(`${base}/api/resume/tailored/${meta.id}/retry`, post({}))).status, 409);
    assert.equal((await fetch(`${base}/api/resume/tailored/${meta.id}/diff`)).status, 404);
    assert.equal((await fetch(`${base}/api/resume/tailored/NOT_AN_ID`)).status, 400);
    const again = await fetch(`${base}/api/resume/tailored`, post({ roleKey: ROLE }));
    assert.equal(again.status, 201, 'a failed record does not block a new request');
    assert.equal((await (await fetch(`${base}/api/resume/tailored`)).json()).length, 2);
    assert.equal((await fetch(`${base}/api/resume/tailored/${meta.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/resume/tailored/${meta.id}`)).status, 404);
  });
});

test('PDF download and accept work when DATA_DIR is inside a dot directory', async () => {
  const dir = path.join(tmpDir(), '.job-quest', 'data');
  const id = 'acme-senior-software-engineer';
  const rec = path.join(dir, 'resume', 'tailored', id);
  fs.mkdirSync(path.join(rec, 'round-1'), { recursive: true });
  fs.writeFileSync(path.join(rec, 'meta.json'), JSON.stringify({
    id, roleKeys: ['Acme|Senior Software Engineer'], company: 'Acme', role: 'Senior Software Engineer', jdUrl: '',
    status: 'done', bestRound: 1, bestScore: 93, accepted: false, acceptedAt: null, trigger: 'manual',
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', error: null, deferred: false,
    gaps: { missing: [], unsupported: [] }, rounds: [{ n: 1, status: 'scored', reason: null, score: 93 }], runs: [{ startRound: 1, finished: true }],
  }));
  fs.writeFileSync(path.join(rec, 'resume.pdf'), '%PDF-1.4 best');
  fs.writeFileSync(path.join(rec, 'round-1', 'resume.pdf'), '%PDF-1.4 round one');
  await withServer(dir, async (base) => {
    const best = await fetch(`${base}/api/resume/tailored/${id}/pdf`);
    assert.equal(best.status, 200);
    assert.match(best.headers.get('content-type'), /^application\/pdf/);
    assert.equal(await best.text(), '%PDF-1.4 best');
    assert.equal(await (await fetch(`${base}/api/resume/tailored/${id}/pdf?round=1`)).text(), '%PDF-1.4 round one');
    assert.equal((await fetch(`${base}/api/resume/tailored/${id}/pdf?round=7`)).status, 404);
    assert.equal((await (await fetch(`${base}/api/resume/tailored/${id}/accept`, post({}))).json()).accepted, true);
    const tracker = await (await fetch(`${base}/api/role-tracker`)).json();
    assert.deepEqual(tracker['Acme|Senior Software Engineer'].timeline.map((e) => e.event), ['Resume tailored (93)']);
  });
});

test('saving a role auto-tailors it unless auto-tailor is off', async () => {
  const dir = tmpDir();
  seedIntel(dir, [{ company: 'Initech', role: 'Senior Software Engineer' }, { company: 'Hooli', role: 'Staff Engineer' }]);
  await withServer(dir, async (base) => {
    await fetch(`${base}/api/role-actions`, post({ saved: [ROLE], skipped: [], applied: [] }));
    let list = await (await fetch(`${base}/api/resume/tailored`)).json();
    assert.deepEqual(list.map((m) => [m.roleKeys[0], m.trigger]), [[ROLE, 'auto-saved']]);
    await fetch(`${base}/api/settings`, put({ resume: { autoTailor: false } }));
    await fetch(`${base}/api/role-actions`, post({ saved: [ROLE, 'Hooli|Staff Engineer'], skipped: [], applied: [] }));
    list = await (await fetch(`${base}/api/resume/tailored`)).json();
    assert.equal(list.length, 1);
  });
});

function seedRecord(dir, id, patch = {}) {
  const rec = path.join(dir, 'resume', 'tailored', id);
  fs.mkdirSync(rec, { recursive: true });
  const meta = {
    id, roleKeys: [ROLE], company: 'Initech', role: 'Senior Software Engineer', jdUrl: '',
    status: 'done', bestRound: 1, bestScore: 93, accepted: false, acceptedAt: null,
    trigger: 'manual', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    error: null, deferred: false, gaps: { missing: [], unsupported: [] }, rounds: [], runs: [],
    ...patch,
  };
  fs.writeFileSync(path.join(rec, 'meta.json'), JSON.stringify(meta));
  return meta;
}

test('applied hooks dedupe every roleKey and do not backfill existing roles', async () => {
  const dir = tmpDir();
  const alias = 'Initech|Senior Engineer';
  const old = 'Old Co|Engineer';
  const actionRole = 'Hooli|Staff Engineer';
  const trackerRole = 'Acme|Engineer';
  const meta = seedRecord(dir, 'existing', { roleKeys: [ROLE, alias] });
  const actions = { saved: [old], skipped: [], applied: [old] };
  const tracker = { [old]: { stage: 'applied' } };
  fs.writeFileSync(path.join(dir, 'role-actions.json'), JSON.stringify(actions));
  fs.writeFileSync(path.join(dir, 'role-tracker.json'), JSON.stringify(tracker));
  await withServer(dir, async (base) => {
    const list = () => fetch(`${base}/api/resume/tailored`).then((r) => r.json());
    assert.equal((await list()).length, 1, 'startup does not backfill');
    assert.equal((await fetch(`${base}/api/role-actions`, post(actions))).status, 200);
    assert.equal((await fetch(`${base}/api/role-tracker`, post(tracker))).status, 200);
    assert.equal((await list()).length, 1, 'unchanged roles do not backfill');
    const existing = await fetch(`${base}/api/resume/tailored`, post({ roleKey: alias }));
    assert.equal(existing.status, 200);
    assert.deepEqual(await existing.json(), { meta, created: false, queue: 'existing' });
    actions.saved.push(alias);
    actions.applied.push(ROLE, actionRole);
    await fetch(`${base}/api/role-actions`, post(actions));
    tracker[alias] = { stage: 'applied' };
    tracker[trackerRole] = { stage: 'applied' };
    await fetch(`${base}/api/role-tracker`, post(tracker));
    const records = await list();
    assert.equal(records.length, 3);
    for (const key of [actionRole, trackerRole]) {
      assert.equal(records.find((m) => m.roleKeys.includes(key)).trigger, 'auto-applied');
    }
    await fetch(`${base}/api/role-actions`, post(actions));
    await fetch(`${base}/api/role-tracker`, post(tracker));
    assert.equal((await list()).length, 3, 'repeated updates do not enqueue again');
    await fetch(`${base}/api/settings`, put({ resume: { autoTailor: false } }));
    tracker['Off Co|Engineer'] = { stage: 'applied' };
    await fetch(`${base}/api/role-tracker`, post(tracker));
    assert.equal((await list()).length, 3);
  });
});

test('auto-tailor has its own default cap of 5 and defers excess jobs', async () => {
  const dir = tmpDir();
  const roles = Array.from({ length: 6 }, (_, i) => `Company ${i}|Engineer`);
  await withServer(dir, async (base) => {
    const settings = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(settings.resume.autoDailyCap, 5);
    await fetch(`${base}/api/settings`, put({ workbooks: { autoBuild: false } }));
    const actions = { saved: roles, skipped: [], applied: [] };
    await fetch(`${base}/api/role-actions`, post(actions));
    const jobs = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(jobs.length, 6);
    assert.ok(jobs.every((j) => j.kind === 'resume' && j.cap.name === 'resume' && j.cap.limit === 5));
    assert.equal(jobs.filter((j) => j.status === 'deferred').length, 1);
    const records = await (await fetch(`${base}/api/resume/tailored`)).json();
    const deferred = records.find((m) => m.deferred);
    assert.deepEqual(deferred.roleKeys, [roles[5]]);
    actions.applied.push(roles[5]);
    await fetch(`${base}/api/role-actions`, post(actions));
    assert.equal((await (await fetch(`${base}/api/jobs`)).json()).length, 6, 'deferred role is deduped');
    const manual = await fetch(`${base}/api/resume/tailored`, post({ roleKey: 'Manual Co|Engineer' }));
    assert.equal(manual.status, 201);
    assert.equal((await manual.json()).queue, 'queued', 'manual requests bypass the auto cap');
  });
});

test('resume handler is registered before persisted jobs start', async () => {
  const dir = tmpDir();
  const id = 'startup-resume';
  seedRecord(dir, id, { status: 'queued', bestRound: null, bestScore: null });
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs/queue.json'), JSON.stringify({ jobs: [{
    id: 'persisted-job', kind: 'resume', key: `resume:${id}`, payload: { id, mode: 'full' },
    status: 'queued', createdAt: '2026-10-05T00:00:00.000Z',
  }], counts: {} }));
  await withServer(dir, async (base) => {
    const rec = await waitFor(base, id, (m) => m.status === 'failed');
    assert.match(rec.meta.error, /no posting URL/);
    const [job] = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(job.status, 'done');
    assert.equal(job.result.id, id);
    assert.equal(job.progress.step, 'fetch');
  });
});

test('all id routes reject crafted ids before reading or changing outside records', async () => {
  const dir = tmpDir();
  seedRecord(dir, '../sentinel');
  const sentinel = path.join(dir, 'resume/sentinel');
  fs.writeFileSync(path.join(sentinel, 'resume.pdf'), '%PDF-1.4 outside');
  const before = fs.readFileSync(path.join(sentinel, 'meta.json'), 'utf8');
  const routes = [
    ['', undefined], ['/jd', put({ text: 'Full job description. '.repeat(20) })],
    ['/retry', post({})], ['/accept', post({})], ['/pdf', undefined], ['/diff', undefined],
    ['', { method: 'DELETE' }],
  ];
  await withServer(dir, async (base) => {
    for (const id of ['..%2Fsentinel', '%2Ftmp%2Fsentinel', '..%5Csentinel', 'NOT_AN_ID', 'a'.repeat(91)]) {
      for (const [suffix, options] of routes) {
        const r = await fetch(`${base}/api/resume/tailored/${id}${suffix}`, options);
        assert.equal(r.status, 400, `${options?.method || 'GET'} ${id}${suffix}`);
        assert.deepEqual(await r.json(), { error: 'invalid id' });
      }
    }
    assert.equal(fs.readFileSync(path.join(sentinel, 'meta.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(sentinel, 'resume.pdf'), 'utf8'), '%PDF-1.4 outside');
    assert.equal(fs.existsSync(path.join(sentinel, 'jd.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'role-tracker.json')), false);
    assert.deepEqual(await (await fetch(`${base}/api/jobs`)).json(), []);
  });
});

for (const route of ['upload', 'upload-zip', 'upload-folder', 'save-file', 'create-file', 'file']) {
  test(`resume ${route} rejects traversal and sibling prefix paths`, async () => {
    const dir = tmpDir();
    const data = Buffer.from('must not escape').toString('base64');
    await withServer(dir, async (base) => {
      for (const filename of ['../escape.tex', '../resume-files-x/escape.tex']) {
        let response;
        if (route === 'file') {
          response = await fetch(`${base}/api/resume/file/${encodeURIComponent(filename)}`);
        } else {
          let body = { filename, data, content: 'must not escape' };
          if (route === 'upload-folder') body = { files: [{ filename: 'escape.tex', relativePath: filename, data }] };
          if (route === 'upload-zip') {
            // Patch equal-length ZIP entry names because AdmZip sanitizes addFile input.
            const AdmZip = require('adm-zip');
            const zip = new AdmZip();
            const placeholder = 'x'.repeat(filename.length - 4) + '.tex';
            zip.addFile(placeholder, Buffer.from('must not escape'));
            const bytes = zip.toBuffer();
            let offset = bytes.indexOf(Buffer.from(placeholder));
            while (offset >= 0) {
              bytes.write(filename, offset);
              offset = bytes.indexOf(Buffer.from(placeholder), offset + filename.length);
            }
            body = { filename: 'resume.zip', data: bytes.toString('base64') };
          }
          response = await fetch(`${base}/api/resume/${route}`, post(body));
        }
        assert.equal(response.status, 400, `${route}: ${filename}`);
        assert.equal(fs.existsSync(path.resolve(dir, 'resume-files', filename)), false);
      }
      if (route !== 'file') {
        const filename = 'nested/valid.tex';
        let body = { filename, data, content: 'valid' };
        if (route === 'upload') body.filename = 'valid.tex';
        if (route === 'upload-folder') body = { files: [{ filename: 'valid.tex', relativePath: 'wrapper/nested/valid.tex', data }] };
        if (route === 'upload-zip') {
          const zip = new (require('adm-zip'))();
          zip.addFile(filename, Buffer.from('valid'));
          body = { filename: 'valid.zip', data: zip.toBuffer().toString('base64') };
        }
        assert.equal((await fetch(`${base}/api/resume/${route}`, post(body))).status, 200);
      }
    });
  });
}
