// app/tests/resume-e2e.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createQueue } = require('../lib/jobs/queue');
const { createResumeService } = require('../lib/resume/pipeline');
const { writeMaster } = require('../lib/resume/master');
const { findTectonic } = require('../lib/resume/render');
const { fetchJd } = require('../lib/resume/jdfetch');
const { loadMaster, loadKeywords, jdText, analystReply, tmpDir } = require('./helpers/resume-fixtures');

const skip = findTectonic() ? false : 'tectonic not installed';
const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');

// The fake tailor copies the master; its first attempt adds an unsupported number so the
// guard re-run path runs end to end.
const TAILOR_SCRIPT = `module.exports = async ({ cwd, fs, path, attempt, prompt }) => {
  fs.writeFileSync(path.join(cwd, '.fake', 'prompt-' + attempt + '.txt'), prompt);
  fs.copyFileSync(path.join(cwd, 'keywords.json'), path.join(cwd, '.fake', 'keywords-' + attempt + '.json'));
  const master = JSON.parse(fs.readFileSync(path.resolve(cwd, '..', '..', 'master.json'), 'utf-8'));
  const keep = (bs) => bs.filter((b) => !b.variantOf).map((b) => ({ src: b.id, text: b.text }));
  const t = {
    headline: master.headline, summary: master.summary,
    experience: master.experience.map((e) => ({ id: e.id, roles: e.roles.map((r) => ({ id: r.id, bullets: keep(r.bullets) })) })),
    projects: master.projects.map((p) => ({ id: p.id, bullets: keep(p.bullets) })),
    skills: master.skills,
  };
  if (attempt === 0) t.experience[0].roles[0].bullets[0].text += ' for 77 teams';
  process.stdout.write('Here is the resume.\\n\`\`\`json\\n' + JSON.stringify(t) + '\\n\`\`\`\\n');
};
`;

async function runE2e(t, { retry = false } = {}) {
  const previousFake = process.env.JOB_QUEST_FAKE_AGENT;
  process.env.JOB_QUEST_FAKE_AGENT = FAKE;
  t.after(() => {
    if (previousFake === undefined) delete process.env.JOB_QUEST_FAKE_AGENT;
    else process.env.JOB_QUEST_FAKE_AGENT = previousFake;
  });
  const paragraphs = jdText().split('\n').map((l) => `<p>${l}</p>`).join('');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><body><main>${paragraphs}</main></body></html>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const dataDir = tmpDir();
  writeMaster(dataDir, loadMaster());
  fs.mkdirSync(path.join(dataDir, 'intel'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'intel', '2026-10-05.json'), JSON.stringify({ roles: [
    { company: 'Initech', role: 'Senior Software Engineer', url: `http://127.0.0.1:${server.address().port}/initech/jobs/1` },
  ] }));
  const handlers = {};
  const queue = createQueue({ dataDir, handlers });
  // Real fetch and extraction; opt into the loopback fixture only in this test.
  const service = createResumeService({ dataDir, queue, deps: {
    fetchJd: (url) => fetchJd(url, { allowPrivate: true }),
  } });
  handlers.resume = (job, ctx) => service.runJob(job, ctx);

  const { meta } = service.requestTailor('Initech|Senior Software Engineer');
  // The job is now awaiting the JD fetch; the agents run after it, so their scripts can be written now.
  const fake = path.join(dataDir, 'resume', 'tailored', meta.id, '.fake');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'jd-analyst.js'), `module.exports = async () => { process.stdout.write(${JSON.stringify(analystReply())}); };\n`);
  fs.writeFileSync(path.join(fake, 'tailor.js'), TAILOR_SCRIPT);
  await queue.drain();

  const r = service.getRecord(meta.id);
  assert.equal(r.meta.status, 'done', JSON.stringify(r.meta, null, 2));
  assert.ok(r.meta.bestScore >= 90, String(r.meta.bestScore));
  assert.equal(r.meta.bestRound, 1);
  assert.deepEqual(r.rounds.map((x) => x.status), ['scored']);
  assert.deepEqual(r.rounds[0].scoreDetail.categories, { ...r.rounds[0].scoreDetail.categories, P: 30, S: 15, H: 15 });
  assert.deepEqual(r.keywords.required.map((k) => k.term), loadKeywords().required.map((k) => k.term));
  const calls = require('./fixtures/fake-calls').readFakeCalls(path.dirname(fake));
  assert.deepEqual(calls, { 'jd-analyst': 1, tailor: 2 });
  const dir = path.join(dataDir, 'resume', 'tailored', meta.id);
  const firstKeywords = fs.readFileSync(path.join(fake, 'keywords-0.json'));
  assert.deepEqual(firstKeywords, fs.readFileSync(path.join(fake, 'keywords-1.json')));
  assert.deepEqual(firstKeywords, fs.readFileSync(path.join(dir, 'keywords.json')));
  const guardRetry = fs.readFileSync(path.join(fake, 'prompt-1.txt'), 'utf8');
  assert.match(guardRetry, /Fix these problems from your previous attempt in this round/);
  assert.match(guardRetry, /\[rule 2\].*77/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'resume.pdf')), fs.readFileSync(path.join(dir, 'round-1', 'resume.pdf')));
  assert.equal(r.rounds[0].guard.pass, true);
  assert.equal(fs.readFileSync(path.join(dir, 'resume.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.match(fs.readFileSync(path.join(dir, 'jd.txt'), 'utf-8'), /Senior Software Engineer, Payments Platform/);
  t.diagnostic(`score ${r.meta.bestScore}: ${JSON.stringify(r.rounds[0].scoreDetail.categories)}`);
  t.diagnostic(`dataDir ${dataDir}`);
  if (retry) {
    const frozen = fs.readFileSync(path.join(dir, 'keywords.json'));
    const bestPdf = fs.readFileSync(path.join(dir, 'resume.pdf'));
    fs.writeFileSync(path.join(fake, 'tailor.js'), TAILOR_SCRIPT.replace(
      'if (attempt === 0)',
      "t.summary = master.headline; t.skills = [{ group: master.skills[0].group, items: master.skills[0].items.slice(0, 1) }]; t.projects = []; for (const e of t.experience) for (const r of e.roles) r.bullets = r.bullets.slice(0, 1); if (attempt === 0)"
    ));
    service.retry(meta.id);
    await queue.drain();
    const retried = service.getRecord(meta.id);
    assert.equal(retried.meta.status, 'done');
    assert.equal(retried.meta.bestRound, 1);
    assert.equal(retried.meta.bestScore, r.meta.bestScore);
    assert.equal(retried.rounds.length, 4);
    for (const round of retried.rounds.slice(1)) {
      assert.equal(round.status, 'scored');
      assert.ok(round.score < 90, String(round.score));
    }
    assert.deepEqual(fs.readFileSync(path.join(dir, 'keywords.json')), frozen);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'resume.pdf')), bestPdf);
    assert.deepEqual(require('./fixtures/fake-calls').readFakeCalls(dir), { 'jd-analyst': 1, tailor: 5 });
    t.diagnostic(`retry scores ${retried.rounds.map((round) => round.score).join(', ')}; best round ${retried.meta.bestRound}`);
  }
}

test('fake runtime, real fetch/guard/render/compile/grade: reaches >= 90 in one round', { skip, timeout: 600000 }, runE2e);

test('fake runtime retry keeps frozen keywords and selects the earlier best PDF', { skip, timeout: 600000 }, (t) => runE2e(t, { retry: true }));

// Exercise the committed CLI with real temp files and a controlled service result;
// no authenticated runtime or public posting is needed for these contract checks.
async function runLiveCommand(args, record) {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const script = path.resolve(__dirname, '../scripts/live-tailor.js');
  const localRequire = createRequire(script);
  const output = [];
  const errors = [];
  const processStub = { argv: ['node', script, ...args], env: {
    JOB_QUEST_FAKE_AGENT: FAKE, JOB_QUEST_RUNTIME_DRY_RUN: '1',
  }, exitCode: 0 };
  let requested;
  let drained = false;
  await vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    require: (name) => {
      if (name === '../lib/jobs/queue') return { createQueue: () => ({ drain: async () => { drained = true; } }) };
      if (name === '../lib/resume/pipeline') return { createResumeService: () => ({
        requestTailor: (key) => { requested = key; return { meta: { id: 'example' } }; },
        getRecord: () => { assert.equal(drained, true); return record; },
      }) };
      return localRequire(name);
    },
    process: processStub,
    URL,
    console: { log: (s) => output.push(s), error: (s) => errors.push(s) },
  }, { filename: script });
  return { output, errors, process: processStub, requested };
}

test('live-tailor refuses non-temp directories and requires an imported master before writing', async (t) => {
  const os = require('node:os');
  const dataDir = tmpDir('jq-live-cli-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const url = 'https://example.com/jobs/1';
  for (const dir of [path.resolve(__dirname, '../..'), os.tmpdir()]) {
    const r = await runLiveCommand([url, dir, 'Initech', 'Engineer']);
    assert.equal(r.process.exitCode, 1);
    assert.match(r.errors.join('\n'), /DATA_DIR must be a directory under the system temp root/);
  }
  // Resolving a symlink must not permit escaping the temporary directory.
  const link = path.join(dataDir, 'outside');
  fs.symlinkSync(path.resolve(__dirname, '../..'), link);
  const escaped = await runLiveCommand([url, link, 'Initech', 'Engineer']);
  assert.equal(escaped.process.exitCode, 1);
  assert.match(escaped.errors.join('\n'), /system temp root/);
  const missing = await runLiveCommand([url, dataDir, 'Initech', 'Engineer']);
  assert.equal(missing.process.exitCode, 1);
  assert.match(missing.errors.join('\n'), /Import and validate the real master first/);
  assert.equal(fs.existsSync(path.join(dataDir, 'intel')), false);
});

test('live-tailor prints the verified live-run field names and selects the best round', async (t) => {
  const dataDir = tmpDir('jq-live-cli-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  writeMaster(dataDir, loadMaster());
  const categories = { K: 23.9, P: 30, S: 15, H: 15, C: 9 };
  const gaps = { unsupported: ['Rust', 'Go', 'GraphQL', 'multi-tenant'] };
  const record = { meta: { status: 'done', bestScore: 93, bestRound: 2, gaps }, rounds: [
    { n: 1, status: 'discarded', reason: 'fact guard', guard: { violations: [{ rule: 7 }] } },
    { n: 2, status: 'scored', score: 93, scoreDetail: { categories, tells: ['3 triad lists in summary'] }, guard: { violations: [] } },
  ] };
  const r = await runLiveCommand(['https://example.com/jobs/1', dataDir, 'Initech', 'Engineer'], record);
  assert.equal(r.process.exitCode, 0, r.errors.join('\n'));
  assert.equal(r.requested, 'Initech|Engineer');
  assert.equal(r.output.length, 1);
  assert.deepEqual(JSON.parse(r.output[0]), {
    status: 'done', score: 93, bestRound: 2, categories, gaps,
    rounds: [
      { n: 1, status: 'discarded', score: null, reason: 'fact guard', categories: null, tells: [], guardCount: 1, guardRules: [7] },
      { n: 2, status: 'scored', score: 93, reason: null, categories, tells: ['3 triad lists in summary'], guardCount: 0, guardRules: [] },
    ],
  });
  assert.equal(r.process.env.JOB_QUEST_FAKE_AGENT, undefined);
  assert.equal(r.process.env.JOB_QUEST_RUNTIME_DRY_RUN, undefined);
  assert.equal(r.process.env.JOB_QUEST_AGENT_RUNTIME_OVERRIDE, 'claude');
  assert.equal(r.process.env.JOB_QUEST_RUNTIME_COMMAND, 'claude');
  const intel = fs.readdirSync(path.join(dataDir, 'intel'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'intel', intel[0]))).roles,
    [{ company: 'Initech', role: 'Engineer', url: 'https://example.com/jobs/1' }]);
});
