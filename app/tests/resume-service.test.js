// app/tests/resume-service.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createQueue } = require('../lib/jobs/queue');
const { writeSettings } = require('../lib/jobs/settings');
const { createResumeService } = require('../lib/resume/pipeline');
const { diffTailored } = require('../lib/resume/diff');
const { writeMaster } = require('../lib/resume/master');
const { loadMaster, loadKeywords, jdText, identityTailored, tmpDir } = require('./helpers/resume-fixtures');

const COMPANIES = ['Acme', 'Bolt', 'Cora', 'Dyno'];
const key = (c) => `${c}|Senior Software Engineer`;

function svc({ clock = '2026-10-05T09:00:00', deps = {} } = {}) {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'intel'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'intel', '2026-10-05.json'), JSON.stringify({
    roles: COMPANIES.map((c) => ({ company: c, role: 'Senior Software Engineer', url: `https://jobs.example.com/${c.toLowerCase()}/1` })),
  }));
  let t = new Date(clock);
  const now = () => t;
  const ran = [];
  // Stub handler: records the run but leaves meta alone, so records stay "queued".
  const queue = createQueue({ dataDir, now, handlers: { resume: async (job) => { ran.push(job.payload.id); return {}; } } });
  const service = createResumeService({ dataDir, queue, now, deps });
  const metaPath = (id) => path.join(dataDir, 'resume', 'tailored', id, 'meta.json');
  const editMeta = (id, patch) => fs.writeFileSync(metaPath(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath(id), 'utf-8')), ...patch }));
  return { dataDir, queue, service, ran, editMeta, setClock: (s) => { t = new Date(s); } };
}

test('requestTailor is idempotent per roleKey', async () => {
  const s = svc();
  const a = s.service.requestTailor(key('Acme'));
  const b = s.service.requestTailor(key('Acme'));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.meta.id, a.meta.id);
  assert.equal(a.meta.id, 'acme-senior-software-engineer');
  assert.equal(a.meta.trigger, 'manual');
  assert.equal(a.meta.jdUrl, 'https://jobs.example.com/acme/1');
  assert.equal(s.queue.list().length, 1);
  await s.queue.drain();
});

test('a failed record does not block a new request, which gets a suffixed id', async () => {
  const s = svc();
  const a = s.service.requestTailor(key('Acme'));
  await s.queue.drain();
  s.editMeta(a.meta.id, { status: 'failed' });
  const b = s.service.requestTailor(key('Acme'));
  assert.equal(b.created, true);
  assert.equal(b.meta.id, 'acme-senior-software-engineer-2');
  assert.throws(() => s.service.requestTailor('no pipe here'), (err) => err.status === 400);
  await s.queue.drain();
});

test('autoTailor respects the off switch and skips roles that already have a resume', async () => {
  const s = svc();
  writeSettings(s.dataDir, { resume: { autoTailor: false } });
  assert.deepEqual(s.service.autoTailor(key('Acme'), 'auto-saved'), { skipped: 'auto-tailor is off' });
  assert.deepEqual(s.service.listMeta(), []);
  writeSettings(s.dataDir, { resume: { autoTailor: true } });
  s.service.requestTailor(key('Bolt'));
  assert.deepEqual(s.service.autoTailor(key('Bolt'), 'auto-applied'), { skipped: 'already tailored or queued' });
  assert.equal(s.service.autoTailor(key('Acme'), 'auto-saved').meta.trigger, 'auto-saved');
  await s.queue.drain();
});

test('auto runs over the daily cap are deferred and promoted the next day; manual ignores the cap', async () => {
  const s = svc();
  writeSettings(s.dataDir, { resume: { autoDailyCap: 2 } });
  const results = ['Acme', 'Bolt', 'Cora'].map((c) => s.service.autoTailor(key(c), 'auto-saved'));
  assert.deepEqual(results.map((r) => r.queue), ['queued', 'queued', 'deferred']);
  assert.equal(results[2].meta.deferred, true);
  await s.queue.drain();
  assert.deepEqual(s.ran, ['acme-senior-software-engineer', 'bolt-senior-software-engineer']);
  s.setClock('2026-10-06T08:00:00');
  await s.queue.tick();
  assert.deepEqual(s.ran, ['acme-senior-software-engineer', 'bolt-senior-software-engineer', 'cora-senior-software-engineer']);
  assert.equal(s.service.requestTailor(key('Dyno')).queue, 'queued');
  await s.queue.drain();
});

test('accept marks the record and appends "Resume tailored (score)" to the role timeline once', async () => {
  const s = svc();
  fs.writeFileSync(path.join(s.dataDir, 'role-actions.json'), JSON.stringify({ saved: [], skipped: [], applied: [key('Acme')] }));
  fs.writeFileSync(path.join(s.dataDir, 'role-tracker.json'), JSON.stringify({ [key('Bolt')]: { stage: 'onsite', notes: 'n', checklist: [], timeline: [{ date: 'x', event: 'Added to tracker' }] } }));
  const a = s.service.requestTailor(key('Acme')).meta;
  const b = s.service.requestTailor(key('Bolt')).meta;
  assert.throws(() => s.service.accept(a.id), (err) => err.status === 409);
  s.editMeta(a.id, { status: 'done', bestRound: 2, bestScore: 91 });
  s.editMeta(b.id, { status: 'below-target', bestRound: 1, bestScore: 84 });
  const accepted = s.service.accept(a.id);
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.acceptedAt);
  s.service.accept(a.id);
  s.service.accept(b.id);
  const tracker = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'role-tracker.json'), 'utf-8'));
  assert.equal(tracker[key('Acme')].stage, 'applied');
  assert.deepEqual(tracker[key('Acme')].timeline.map((e) => e.event), ['Resume tailored (91)']);
  assert.equal(tracker[key('Bolt')].stage, 'onsite');
  assert.deepEqual(tracker[key('Bolt')].timeline.map((e) => e.event), ['Added to tracker', 'Resume tailored (84)']);
  await s.queue.drain();
});

test('setJd refuses once keywords are frozen', async () => {
  const s = svc();
  const { meta } = s.service.requestTailor(key('Acme'));
  s.editMeta(meta.id, { status: 'failed' });
  fs.writeFileSync(path.join(s.dataDir, 'resume', 'tailored', meta.id, 'keywords.json'), '{}');
  assert.throws(() => s.service.setJd(meta.id, 'x'.repeat(300)), (err) => err.status === 409 && /frozen/.test(err.message));
  await s.queue.drain();
});

test('pdfPath validation, remove, and 404 after removal', async () => {
  const s = svc();
  const { meta } = s.service.requestTailor(key('Acme'));
  const dir = path.join(s.dataDir, 'resume', 'tailored', meta.id);
  assert.throws(() => s.service.pdfPath(meta.id), (err) => err.status === 404);
  assert.throws(() => s.service.pdfPath(meta.id, 'abc'), (err) => err.status === 400);
  assert.throws(() => s.service.pdfPath('../../etc'), (err) => err.status === 400);
  fs.mkdirSync(path.join(dir, 'round-2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'round-2', 'resume.pdf'), '%PDF');
  assert.equal(s.service.pdfPath(meta.id, '2'), path.join(dir, 'round-2', 'resume.pdf'));
  s.service.remove(meta.id);
  assert.equal(fs.existsSync(dir), false);
  assert.throws(() => s.service.getRecord(meta.id), (err) => err.status === 404);
  await s.queue.drain();
});

test('diffTailored labels kept, rewritten, and deleted-source bullets and lists unused ones', () => {
  const master = loadMaster();
  const t = identityTailored(master);
  t.experience[0].roles[0].bullets = [
    { src: 'exp.sr.1', text: master.experience[0].roles[0].bullets[0].text },
    { src: 'exp.sr.2', text: 'Reduced P99 API latency from 900ms to 250ms with a Redis cache.' },
    { src: 'exp.sr.99', text: 'A bullet whose source was deleted from the master.' },
  ];
  t.projects = [t.projects[1]];
  const d = diffTailored(master, t);
  const sr = d.experience[0].roles[0];
  assert.equal(sr.title, 'Senior Software Engineer');
  assert.deepEqual(sr.items.map((i) => [i.src, i.status]), [['exp.sr.1', 'kept'], ['exp.sr.2', 'rewritten'], ['exp.sr.99', 'unknown-source']]);
  assert.equal(sr.items[2].master, null);
  assert.deepEqual(sr.items[1].ops[0], { op: 'del', text: 'Cut' });
  assert.deepEqual(sr.dropped.map((b) => b.id), ['exp.sr.3', 'exp.sr.4', 'exp.sr.5']);
  assert.deepEqual(d.projects.map((p) => [p.id, p.included]), [['proj.pantry', false], ['proj.relay', true]]);
  assert.equal(d.experience[0].roles[1].items.every((i) => i.status === 'kept'), true);
});

async function keywordRun(t, { analyst, jd = jdText() } = {}) {
  const calls = [];
  const master = loadMaster();
  const s = svc({ deps: {
    fetchJd: async () => ({ ok: true, text: jd }),
    runAgent: async (options) => {
      if (options.agent === 'jd-analyst') {
        calls.push(options);
        if (analyst) return analyst(options, calls.length);
        return { ok: true, stdout: JSON.stringify(loadKeywords()) };
      }
      return { ok: true, stdout: JSON.stringify(identityTailored(master)) };
    },
    compileTex: async ({ texPath }) => {
      const pdfPath = texPath.replace(/\.tex$/, '.pdf');
      fs.writeFileSync(pdfPath, '%PDF stub');
      return { ok: true, pdfPath };
    },
    gradePdf: async () => ({ total: 90, keywords: { requiredMiss: [] } }),
  } });
  t.after(() => fs.rmSync(s.dataDir, { recursive: true, force: true }));
  writeMaster(s.dataDir, master);
  const { meta } = s.service.requestTailor(key('Acme'));
  await s.queue.drain(); // The stub queue leaves execution to this test.
  return {
    ...s, calls,
    kwFile: path.join(s.dataDir, 'resume', 'tailored', meta.id, 'keywords.json'),
    run: async () => {
      await s.service.runJob({ payload: { id: meta.id, mode: 'full' } });
      return s.service.getRecord(meta.id);
    },
  };
}

test('an interrupted keyword write leaves no frozen file and a full run can recover', async (t) => {
  const h = await keywordRun(t);
  const write = fs.writeFileSync;
  let interrupted = false;
  let interruptedFile;
  const mock = t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (!interrupted && (file === h.kwFile || (file.startsWith(`${h.kwFile}.`) && file.endsWith('.tmp')))) {
      interrupted = true;
      interruptedFile = file;
      write(file, '{"title":', options);
      throw new Error('simulated interrupted keyword write');
    }
    return write(file, data, options);
  });
  const failed = await h.run();
  mock.mock.restore();
  assert.equal(interrupted, true);
  assert.equal(failed.meta.status, 'failed');
  assert.match(failed.meta.error, /simulated interrupted keyword write/);
  assert.equal(fs.existsSync(h.kwFile), false, 'partial JSON must never be published as frozen keywords');
  assert.equal(fs.existsSync(interruptedFile), false, 'failed temporary writes are cleaned up');
  const recovered = await h.run();
  assert.equal(recovered.meta.status, 'done');
  assert.deepEqual(recovered.keywords, loadKeywords());
  assert.deepEqual(fs.readdirSync(path.dirname(h.kwFile)).filter((name) => name.endsWith('.tmp')), []);
});

test('keywords created while the analyst runs are never overwritten', async (t) => {
  const frozen = JSON.stringify({ ...loadKeywords(), title: 'Already frozen' });
  const h = await keywordRun(t, { analyst: async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'keywords.json'), frozen);
    return { ok: true, stdout: JSON.stringify(loadKeywords()) };
  } });
  const r = await h.run();
  assert.equal(r.meta.status, 'failed');
  assert.equal(fs.readFileSync(h.kwFile, 'utf8'), frozen);
  assert.deepEqual(r.rounds, []);
});

for (const retry of ['crashed', 'unparseable', 'throws', 'too few']) {
  test(`a usable oversized first keyword set survives a retry that ${retry}`, async (t) => {
    const required = Array.from({ length: 22 }, (_, i) => ({ term: `required${i}`, alts: [] }));
    const preferred = Array.from({ length: 17 }, (_, i) => ({ term: `preferred${i}`, alts: [] }));
    const candidate = { title: 'Engineer', required, preferred };
    const h = await keywordRun(t, {
      jd: [...required, ...preferred].map((k) => k.term).join(' '),
      analyst: async (options, n) => {
        if (n === 1) return { ok: true, stdout: JSON.stringify(candidate) };
        if (retry === 'crashed') return { ok: false, code: 1 };
        if (retry === 'unparseable') return { ok: true, stdout: 'not JSON' };
        if (retry === 'throws') throw new Error('analyst process failed');
        return { ok: true, stdout: JSON.stringify({ ...candidate, required: required.slice(0, 5) }) };
      },
    });
    const r = await h.run();
    assert.equal(r.meta.status, 'done');
    assert.equal(h.calls.length, 2);
    assert.match(h.calls[1].prompt, /22 required and 17 preferred/);
    assert.deepEqual(r.keywords, { title: 'Engineer', required: required.slice(0, 20), preferred: preferred.slice(0, 15) });
  });
}
