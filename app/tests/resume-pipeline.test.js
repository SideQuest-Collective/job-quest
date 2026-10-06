// app/tests/resume-pipeline.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createQueue } = require('../lib/jobs/queue');
const { createResumeService } = require('../lib/resume/pipeline');
const { writeMaster } = require('../lib/resume/master');
const { loadMaster, loadKeywords, jdText, identityTailored, analystReply, tmpDir } = require('./helpers/resume-fixtures');

const ROLE = 'Initech|Senior Software Engineer';
const fence = (v) => '```json\n' + JSON.stringify(v) + '\n```';

function harness({ scores = [], tailorReplies = null, analystReplies = null, compileFails = [], fetchResult = null, master = loadMaster(), now, overrides = {} } = {}) {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'intel'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'intel', '2026-10-05.json'), JSON.stringify({ roles: [{ company: 'Initech', role: 'Senior Software Engineer', url: 'https://jobs.example.com/initech/1' }] }));
  if (master) writeMaster(dataDir, master);
  const calls = { analyst: [], tailor: [], compile: 0, grade: 0, fetch: 0, agents: [], compiles: [] };
  const good = fence(identityTailored(loadMaster()));
  const deps = {
    fetchJd: async () => { calls.fetch++; return fetchResult || { ok: true, text: jdText() }; },
    runAgent: async (options) => {
      calls.agents.push(options);
      const { agent, prompt } = options;
      if (agent === 'jd-analyst') {
        calls.analyst.push(prompt);
        const reply = analystReplies ? analystReplies[calls.analyst.length - 1] : analystReply();
        return { ok: true, code: 0, timedOut: false, stdout: reply, stderr: '' };
      }
      calls.tailor.push(prompt);
      const scripted = tailorReplies ? tailorReplies[calls.tailor.length - 1] : undefined;
      return { ok: true, code: 0, timedOut: false, stdout: scripted === undefined ? good : scripted, stderr: '' };
    },
    compileTex: async ({ texPath }) => {
      calls.compile++;
      calls.compiles.push(texPath);
      if (compileFails.includes(calls.compile)) return { ok: false, pdfPath: null, log: '! Undefined control sequence.' };
      const pdfPath = texPath.replace(/\.tex$/, '.pdf');
      fs.writeFileSync(pdfPath, `%PDF-1.4 stub ${calls.compile}`);
      return { ok: true, pdfPath, log: '' };
    },
    gradePdf: async () => {
      calls.grade++;
      const total = scores.length ? scores.shift() : 50;
      return {
        total, categories: { K: 20, P: 30, S: 15, H: 15, C: 10 },
        keywords: { requiredHit: [], requiredMiss: ['Kafka', 'Fortran'], preferredHit: [], preferredMiss: [], stuffed: [] },
        checks: [], tells: [], words: 500, pages: 1,
      };
    },
  };
  const handlers = {};
  const queue = createQueue({ dataDir, handlers });
  const service = createResumeService({ dataDir, queue, now, deps: { ...deps, ...overrides } });
  handlers.resume = (job, ctx) => service.runJob(job, ctx);
  const recDir = (id) => path.join(dataDir, 'resume', 'tailored', id);
  return { dataDir, calls, service, queue, good, recDir };
}

const badNumber = () => { const t = identityTailored(loadMaster()); t.experience[0].roles[0].bullets[0].text += ' for 77 teams'; return fence(t); };

async function run(h) {
  const { meta } = h.service.requestTailor(ROLE);
  await h.queue.drain();
  return h.service.getRecord(meta.id);
}

test('stops at the first round scoring >= 90 and publishes the best PDF', async () => {
  const h = harness({ scores: [93] });
  const r = await run(h);
  assert.equal(r.meta.id, 'initech-senior-software-engineer');
  assert.equal(r.meta.status, 'done');
  assert.equal(r.meta.bestRound, 1);
  assert.equal(r.meta.bestScore, 93);
  assert.equal(h.calls.tailor.length, 1);
  assert.equal(fs.readFileSync(path.join(h.recDir(r.meta.id), 'resume.pdf'), 'utf-8'), '%PDF-1.4 stub 1');
  assert.deepEqual(r.meta.gaps, { missing: ['Kafka', 'Fortran'], unsupported: ['Fortran'] });
  assert.deepEqual(r.keywords.required.map((k) => k.term), loadKeywords().required.map((k) => k.term));
  for (const f of ['jd.txt', 'keywords.json', 'round-1/tailored.json', 'round-1/guard.json', 'round-1/score.json', 'round-1/resume.pdf']) {
    assert.ok(fs.existsSync(path.join(h.recDir(r.meta.id), f)), f);
  }
});

test('caps at 3 rounds, reports below-target, and feeds the previous score into the next prompt', async () => {
  const h = harness({ scores: [70, 80, 85] });
  const r = await run(h);
  assert.equal(r.meta.status, 'below-target');
  assert.deepEqual(r.rounds.map((x) => [x.n, x.status, x.score]), [[1, 'scored', 70], [2, 'scored', 80], [3, 'scored', 85]]);
  assert.equal(r.meta.bestRound, 3);
  assert.equal(h.calls.tailor.length, 3);
  assert.ok(!h.calls.tailor[0].includes('## Previous round'));
  assert.match(h.calls.tailor[1], /## Previous round \(round 1, score 70\/100\)/);
  assert.match(h.calls.tailor[2], /Required keywords still missing: Kafka, Fortran/);
});

test('the best round wins and ties go to the earliest round', async () => {
  const h = harness({ scores: [88, 88, 86] });
  const r = await run(h);
  assert.equal(r.meta.bestRound, 1);
  assert.equal(r.meta.bestScore, 88);
  assert.equal(fs.readFileSync(path.join(h.recDir(r.meta.id), 'resume.pdf'), 'utf-8'), '%PDF-1.4 stub 1');
});

test('a guard violation gets one in-round re-run with the violation list', async () => {
  const h = harness({ scores: [92], tailorReplies: [badNumber()] });
  const r = await run(h);
  assert.equal(h.calls.tailor.length, 2);
  assert.match(h.calls.tailor[1], /## Fix these problems from your previous attempt in this round/);
  assert.match(h.calls.tailor[1], /77/);
  assert.deepEqual(r.rounds.map((x) => x.status), ['scored']);
  assert.equal(r.rounds[0].guard.pass, true);
});

test('a round that still violates after the re-run is discarded and the next round runs', async () => {
  const h = harness({ scores: [91], tailorReplies: [badNumber(), badNumber()] });
  const r = await run(h);
  assert.deepEqual(r.rounds.map((x) => [x.n, x.status]), [[1, 'discarded'], [2, 'scored']]);
  assert.match(r.rounds[0].reason, /^fact guard \(1 violation\)$/);
  assert.equal(r.meta.bestRound, 2);
  assert.match(h.calls.tailor[2], /## Previous round \(round 1\) was discarded/);
});

test('a compile failure discards the round with the log tail', async () => {
  const h = harness({ scores: [95], compileFails: [1] });
  const r = await run(h);
  assert.deepEqual(r.rounds.map((x) => x.status), ['discarded', 'scored']);
  assert.match(r.rounds[0].reason, /^compile failed: ! Undefined control sequence\.$/);
  assert.ok(fs.existsSync(path.join(h.recDir(r.meta.id), 'round-1', 'compile.log')));
  assert.equal(r.meta.bestRound, 2);
});

test('retry runs up to 3 more rounds with frozen keywords; numbering continues', async () => {
  const h = harness({ scores: [70, 80, 85, 95] });
  const first = await run(h);
  const kwFile = path.join(h.recDir(first.meta.id), 'keywords.json');
  const frozen = fs.readFileSync(kwFile, 'utf-8');
  h.service.retry(first.meta.id);
  assert.throws(() => h.service.retry(first.meta.id), /already queued or running/);
  await h.queue.drain();
  const r = h.service.getRecord(first.meta.id);
  assert.deepEqual(r.rounds.map((x) => x.n), [1, 2, 3, 4]);
  assert.equal(r.meta.status, 'done');
  assert.equal(r.meta.bestRound, 4);
  assert.equal(h.calls.analyst.length, 1);
  assert.equal(h.calls.fetch, 1);
  assert.equal(fs.readFileSync(kwFile, 'utf-8'), frozen);
  assert.deepEqual(r.meta.runs.map((x) => [x.startRound, x.finished]), [[1, true], [4, true]]);
});

test('an unavailable posting fails with a paste hint; a pasted JD resumes from the analyst', async () => {
  const h = harness({ scores: [90], fetchResult: { ok: false, reason: 'HTTP 404' } });
  const failed = await run(h);
  assert.equal(failed.meta.status, 'failed');
  assert.match(failed.meta.error, /^posting unavailable: HTTP 404\. Paste the job description to continue\.$/);
  assert.throws(() => h.service.setJd(failed.meta.id, 'too short'), (err) => err.status === 400);
  h.service.setJd(failed.meta.id, jdText());
  await h.queue.drain();
  const r = h.service.getRecord(failed.meta.id);
  assert.equal(r.meta.status, 'done');
  assert.equal(h.calls.fetch, 1);
  assert.equal(h.calls.analyst.length, 1);
});

test('the analyst gets one retry with the counts, then the job fails if still too few', async () => {
  const kw = loadKeywords();
  const five = '```json\n' + JSON.stringify({ ...kw, required: kw.required.slice(0, 5) }) + '\n```';
  const ok = await run(harness({ scores: [90], analystReplies: [five, analystReply()] }));
  assert.equal(ok.meta.status, 'done');
  const h = harness({ scores: [90], analystReplies: [five, five] });
  const r = await run(h);
  assert.equal(h.calls.analyst.length, 2);
  assert.match(h.calls.analyst[1], /## Fix the counts/);
  assert.match(h.calls.analyst[1], /5 required and 3 preferred/);
  assert.equal(r.meta.status, 'failed');
  assert.match(r.meta.error, /only 5 verified required keywords/);
  assert.equal(fs.existsSync(path.join(h.recDir(r.meta.id), 'keywords.json')), false);
});

test('agent JSON wrapped in prose parses; unparseable output is a schema violation, never a crash', async () => {
  const h1 = harness({ scores: [90], tailorReplies: [`Sure! Here it is:\n${fence(identityTailored(loadMaster()))}\nLet me know.`] });
  assert.deepEqual((await run(h1)).rounds.map((x) => x.status), ['scored']);
  const h2 = harness({ scores: [90], tailorReplies: ['not json', 'still not json'] });
  const r = await run(h2);
  assert.deepEqual(r.rounds.map((x) => x.status), ['discarded', 'scored']);
  assert.equal(r.rounds[0].guard.violations[0].rule, 'schema');
  assert.match(r.rounds[0].guard.violations[0].detail, /no JSON object found/);
});

test('a job interrupted mid-run resumes at the next round of the same run', async () => {
  const h = harness({ scores: [70, 80, 85, 92] });
  const done = await run(h);
  const metaFile = path.join(h.recDir(done.meta.id), 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  meta.rounds = meta.rounds.slice(0, 2); // round 3 never recorded: the crash happened inside it
  meta.runs[0].finished = false;
  meta.status = 'running';
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  await h.service.runJob({ payload: { id: done.meta.id, mode: 'full' } }, { update() {} });
  const r = h.service.getRecord(done.meta.id);
  assert.deepEqual(r.rounds.map((x) => [x.n, x.score]), [[1, 70], [2, 80], [3, 92]]);
  assert.equal(r.meta.status, 'done');
  assert.equal(h.calls.analyst.length, 1);
  assert.equal(h.calls.fetch, 1);
});

test('an empty master fails the job with guidance', async () => {
  const r = await run(harness({ master: null }));
  assert.equal(r.meta.status, 'failed');
  assert.match(r.meta.error, /master resume is empty/);
});

test('agents use read profile, record cwd, exact timeouts and log; each round compiles separately', async () => {
  const h = harness({ scores: [70, 92] });
  const r = await run(h);
  const dir = h.recDir(r.meta.id);
  assert.deepEqual(h.calls.agents.map((x) => [x.agent, x.profile, x.timeoutMs]), [
    ['jd-analyst', 'read', 300000], ['tailor', 'read', 600000], ['tailor', 'read', 600000],
  ]);
  for (const call of h.calls.agents) {
    assert.equal(call.cwd, dir);
    assert.equal(call.logFile, path.join(dir, 'agents.log'));
  }
  assert.deepEqual(h.calls.compiles, [1, 2].map((n) => path.join(dir, `round-${n}`, 'resume.tex')));
});

test('synchronous and asynchronous compile errors discard rounds with the error log', async () => {
  let count = 0;
  const h = harness({ scores: [90], overrides: {
    compileTex({ texPath }) {
      count++;
      if (count === 1) throw new Error('a .tex path is required');
      if (count === 2) return Promise.reject(new Error('compiler unavailable'));
      const pdfPath = texPath.replace(/\.tex$/, '.pdf');
      fs.writeFileSync(pdfPath, '%PDF stub');
      return { ok: true, pdfPath };
    },
  } });
  const r = await run(h);
  assert.deepEqual(r.rounds.map((x) => x.status), ['discarded', 'discarded', 'scored']);
  assert.equal(r.rounds[0].reason, 'compile failed: a .tex path is required');
  assert.equal(r.rounds[1].reason, 'compile failed: compiler unavailable');
  assert.equal(fs.readFileSync(path.join(h.recDir(r.meta.id), 'round-1/compile.log'), 'utf8'), 'a .tex path is required');
});

test('missing, corrupt or empty frozen keywords fail before grading and are never regenerated', async () => {
  for (const damaged of [null, '{invalid', JSON.stringify({ required: [], preferred: [] })]) {
    const h = harness({ scores: [90] });
    const first = await run(h);
    const file = path.join(h.recDir(first.meta.id), 'keywords.json');
    if (damaged === null) fs.unlinkSync(file);
    else fs.writeFileSync(file, damaged);
    const result = await h.service.runJob({ payload: { id: first.meta.id, mode: 'retry' } });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /keywords missing/);
    assert.equal(h.calls.grade, 1);
    assert.equal(h.calls.analyst.length, 1);
    if (damaged !== null) assert.equal(fs.readFileSync(file, 'utf8'), damaged);
    else assert.equal(fs.existsSync(file), false);
  }
});

test('keywords must still exist immediately before grading', async () => {
  const h = harness({ overrides: {
    compileTex: async ({ texPath }) => {
      fs.unlinkSync(path.join(path.dirname(path.dirname(texPath)), 'keywords.json'));
      const pdfPath = texPath.replace(/\.tex$/, '.pdf');
      fs.writeFileSync(pdfPath, '%PDF stub');
      return { ok: true, pdfPath };
    },
  } });
  const r = await run(h);
  assert.equal(r.meta.status, 'failed');
  assert.match(r.meta.error, /keywords missing/);
  assert.equal(h.calls.grade, 0);
});

test('oversized analyst keywords get one count retry then truncate in analyst order', async () => {
  const required = Array.from({ length: 22 }, (_, i) => ({ term: `required${i}`, alts: [] }));
  const preferred = Array.from({ length: 17 }, (_, i) => ({ term: `preferred${i}`, alts: [] }));
  const reply = fence({ title: 'Engineer', required, preferred });
  const h = harness({ scores: [90], analystReplies: [reply, reply], fetchResult: {
    ok: true, text: [...required, ...preferred].map((k) => k.term).join(' '),
  } });
  const r = await run(h);
  assert.equal(r.meta.status, 'done');
  assert.equal(h.calls.analyst.length, 2);
  assert.match(h.calls.analyst[1], /22 required and 17 preferred/);
  assert.deepEqual(r.keywords.required, required.slice(0, 20));
  assert.deepEqual(r.keywords.preferred, preferred.slice(0, 15));
});

test('fetch failures use the posting unavailable reason without enabling private URLs', async () => {
  for (const reason of ['HTTP 404', 'private host', 'timeout', 'unsupported content type']) {
    const h = harness({ overrides: {
      fetchJd: async (url, options) => {
        assert.equal(url, 'https://jobs.example.com/initech/1');
        assert.equal(options?.allowPrivate, undefined);
        return { ok: false, reason };
      },
    } });
    const r = await run(h);
    assert.equal(r.meta.status, 'failed');
    assert.equal(r.meta.error, `posting unavailable: ${reason}. Paste the job description to continue.`);
    assert.equal(h.calls.analyst.length, 0);
  }
});

test('running records cannot be deleted; deleted queued records are skipped', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = harness({ scores: [90], overrides: { fetchJd: () => pending } });
  const { meta } = h.service.requestTailor(ROLE);
  try {
    assert.equal(h.service.getRecord(meta.id).meta.status, 'running');
    assert.throws(() => h.service.remove(meta.id), (e) => e.status === 409);
  } finally {
    release({ ok: true, text: jdText() });
    await h.queue.drain();
  }
  h.service.remove(meta.id);
  assert.deepEqual(await h.service.runJob({ payload: { id: meta.id } }), { skipped: 'record deleted' });
  assert.equal(fs.existsSync(h.recDir(meta.id)), false);
});

test('injected date strings and numbers normalize every timestamp to ISO', async () => {
  for (const value of ['2026-10-05T10:00:00-04:00', Date.parse('2026-10-05T14:00:00Z')]) {
    const h = harness({ scores: [90], now: () => value });
    const r = await run(h);
    const accepted = h.service.accept(r.meta.id);
    const expected = '2026-10-05T14:00:00.000Z';
    for (const t of [accepted.createdAt, accepted.updatedAt, accepted.acceptedAt, accepted.runs[0].startedAt]) assert.equal(t, expected);
    const tracker = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'role-tracker.json'), 'utf8'));
    assert.equal(tracker[ROLE].timeline[0].date, expected);
  }
});

test('malformed job ids never throw and public record lookups return a service error', async () => {
  const h = harness();
  for (const id of [123, {}, '../escape', '', null, undefined]) {
    assert.deepEqual(await h.service.runJob({ payload: { id } }), { skipped: 'record deleted' });
    assert.throws(() => h.service.getRecord(id), (e) => e.status === 400);
  }
});

test('requests deduplicate and auto cap deferrals preserve queued metadata', async () => {
  const h = harness({ overrides: { readSettings: () => ({ resume: { autoTailor: true, autoDailyCap: 0 } }) } });
  const first = h.service.autoTailor(ROLE, 'auto-saved');
  assert.equal(first.created, true);
  assert.equal(first.queue, 'deferred');
  assert.equal(first.meta.status, 'queued');
  assert.equal(first.meta.deferred, true);
  assert.equal(first.meta.trigger, 'auto-saved');
  assert.deepEqual(h.queue.list()[0].cap, { name: 'resume', limit: 0 });
  assert.deepEqual(h.queue.list()[0].payload, { id: first.meta.id, mode: 'full' });
  assert.equal(h.queue.list()[0].key, `resume:${first.meta.id}`);
  const again = h.service.requestTailor(ROLE);
  assert.equal(again.created, false);
  assert.equal(again.queue, 'existing');
  assert.equal(again.meta.id, first.meta.id);
  assert.equal(h.service.listMeta().length, 1);
  assert.equal(h.queue.list().length, 1);
  h.service.remove(first.meta.id);
  assert.deepEqual(await h.service.runJob(h.queue.list()[0]), { skipped: 'record deleted' });
});

test('all discarded rounds fail without publishing a PDF; dependency errors are recorded', async () => {
  const h = harness({ compileFails: [1, 2, 3] });
  const r = await run(h);
  assert.equal(r.meta.status, 'failed');
  assert.equal(r.meta.bestRound, null);
  assert.match(r.meta.error, /no round produced a gradable resume/);
  assert.deepEqual(r.rounds.map((x) => x.status), ['discarded', 'discarded', 'discarded']);
  assert.equal(h.calls.grade, 0);
  assert.equal(fs.existsSync(path.join(h.recDir(r.meta.id), 'resume.pdf')), false);
  const throwing = harness({ overrides: { gradePdf: async () => { throw new Error('extract failed'); } } });
  const failed = await run(throwing);
  assert.equal(failed.meta.status, 'failed');
  assert.equal(failed.meta.error, 'unexpected error: extract failed');
  assert.deepEqual(failed.rounds, []);
});

test('tailor prompts omit master contact email and phone', async () => {
  const h = harness({ scores: [90] });
  await run(h);
  const { email, phone } = loadMaster().contact;
  assert.ok(email && phone);
  for (const prompt of h.calls.tailor) {
    assert.equal(prompt.includes(email), false);
    assert.equal(prompt.includes(phone), false);
    assert.equal(prompt.includes('"contact"'), false);
  }
});

test('pipeline supplies frozen keywords to lowercase tool guard', async () => {
  const keywords = loadKeywords();
  keywords.required.push({ term: 'Rust', alts: [] }, { term: 'Go', alts: [] });
  const tailored = identityTailored(loadMaster());
  tailored.experience[0].roles[0].bullets[0].text = 'Built services in rust and go.';
  const h = harness({ scores: [90], analystReplies: [fence(keywords)], tailorReplies: [fence(tailored)],
    fetchResult: { ok: true, text: jdText() + ' Rust and Go.' } });
  await run(h);
  assert.ok(h.calls.tailor.length >= 2);
  assert.match(h.calls.tailor[1], /tools not in the source bullet or master skills:.*Rust.*Go/);
});
