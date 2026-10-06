// Usage: node app/scripts/live-tailor.js <role-url> <temp-data-dir> <company> <role>
// Real Claude runtime; import the master into a fresh system-temp directory first.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQueue } = require('../lib/jobs/queue');
const { createResumeService } = require('../lib/resume/pipeline');
const { readMaster, validateMaster } = require('../lib/resume/master');

(async () => {
  const [url, inputDir, company, role] = process.argv.slice(2);
  if (!url || !inputDir || !company || !role) throw new Error('Supply URL, temp DATA_DIR, company, and role');
  if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Expected an HTTP(S) posting');
  const dataDir = fs.realpathSync(inputDir);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (!dataDir.startsWith(tempRoot + path.sep) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error('DATA_DIR must be a directory under the system temp root');
  }
  const master = readMaster(dataDir);
  if (!validateMaster(master).ok || !master.experience.length) throw new Error('Import and validate the real master first');

  delete process.env.JOB_QUEST_FAKE_AGENT;
  delete process.env.JOB_QUEST_RUNTIME_DRY_RUN;
  process.env.JOB_QUEST_AGENT_RUNTIME_OVERRIDE = 'claude';
  process.env.JOB_QUEST_RUNTIME_COMMAND = 'claude';
  fs.mkdirSync(path.join(dataDir, 'intel'), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dataDir, 'intel', `${date}.json`), JSON.stringify({ date, roles: [{ company, role, url }] }));
  const handlers = {};
  const queue = createQueue({ dataDir, handlers });
  const service = createResumeService({ dataDir, queue });
  handlers.resume = (job, ctx) => service.runJob(job, ctx);
  const { meta } = service.requestTailor(`${company}|${role}`);
  await queue.drain();
  const result = service.getRecord(meta.id);
  const best = result.rounds.find((round) => round.n === result.meta.bestRound);
  console.log(JSON.stringify({
    status: result.meta.status, score: result.meta.bestScore ?? null,
    bestRound: result.meta.bestRound ?? null,
    categories: best?.scoreDetail?.categories ?? null, gaps: result.meta.gaps ?? null,
    rounds: result.rounds.map((round) => ({
      n: round.n, status: round.status, score: round.score ?? null, reason: round.reason ?? null,
      categories: round.scoreDetail?.categories ?? null, tells: round.scoreDetail?.tells ?? [],
      guardCount: round.guard?.violations?.length ?? null,
      guardRules: round.guard?.violations?.map((violation) => violation.rule) ?? [],
    })),
  }, null, 2));
  if (!['done', 'below-target'].includes(result.meta.status)) process.exitCode = 1;
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
