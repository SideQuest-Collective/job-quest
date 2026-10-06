// app/lib/workbook/orchestrator.js
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { parseContentDir } = require('./parse');
const prepareSteps = require('./steps-prepare');
const { checkLinks } = require('./linkcheck');
const { verifyQuestion } = require('./verify');
const { runAgent: defaultRunAgent } = require('../jobs/runner');

const STEPS = ['research', 'links', 'plan', 'write', 'verify', 'review', 'glossary', 'publish'];
const MODE_STEPS = { create: STEPS, expand: STEPS, retry: ['write', 'verify', 'review', 'glossary', 'publish'] };
const TIMEOUTS = { researcher: 15 * 60000, planner: 5 * 60000, writer: 12 * 60000, editor: 8 * 60000 };
const chapterSteps = require('./steps-chapters');

const DEFAULT_STEPS = {
  research: prepareSteps.research,
  links: prepareSteps.links,
  plan: prepareSteps.plan,
  write: chapterSteps.write,
  verify: chapterSteps.verify,
  review: chapterSteps.review,
  glossary: chapterSteps.glossary,
  publish: chapterSteps.publish,
};
const WRITTEN = new Set(['written', 'verified', 'reviewed', 'published']);

function dispatchAgent(runAgent, args) {
  const family = args.agent.split('-')[0];
  const profile = { researcher: 'research', planner: 'read', writer: 'write', editor: 'edit' }[family];
  if (!profile) throw new Error(`unknown workbook agent: ${args.agent}`);
  let prompt = args.prompt;
  if (family === 'planner' || family === 'writer') {
    // Rebuild the research fence at the shared dispatch boundary, including writer
    // and fix prompts supplied by chapter steps. Keep the source file unchanged.
    const start = prompt.indexOf('<research>');
    const end = prompt.lastIndexOf('</research>');
    if (start >= 0 && end > start) {
      const body = start + '<research>'.length;
      prompt = prompt.slice(0, body) + prepareSteps.escapeResearch(prompt.slice(body, end)) + prompt.slice(end);
    }
  }
  return runAgent({ ...args, prompt, profile });
}

function readProfileDefault(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'profile.json'), 'utf-8')); } catch { return {}; }
}

function initState(job, meta, prev, mode, nowIso) {
  const chapters = prev && prev.chapters ? prev.chapters : {};
  if (mode === 'retry') {
    for (const c of Object.values(chapters)) {
      if (c.status === 'failed') Object.assign(c, { status: 'pending', attempts: 0, fixRounds: 0, lint: [], verify: [], review: null, error: null, run: job.id });
    }
  }
  const steps = {};
  for (const s of STEPS) steps[s] = { status: MODE_STEPS[mode].includes(s) ? 'pending' : 'skipped' };
  return {
    runId: job.id, workbookId: meta.id, mode, tier: mode === 'expand' ? 'onsite' : meta.tier,
    status: 'running', current: null, steps, chapters, startedAt: nowIso, updatedAt: nowIso, error: null,
  };
}

function computeStatus(dir, state) {
  const published = parseContentDir(path.join(dir, 'content')).chapters.filter((c) => c.id !== store.ASKED.id).length;
  const failed = Object.values(state.chapters || {}).filter((c) => c.status === 'failed').length;
  if (!published) return 'failed';
  return failed ? 'partial' : 'ready';
}

function createWorkbookHandler(deps = {}) {
  const { dataDir } = deps;
  const now = deps.now || (() => new Date());
  const impls = deps.stepImpls || DEFAULT_STEPS;

  return async function handleWorkbookJob(job, ctx = { update() {} }) {
    const id = job && job.payload && job.payload.workbookId;
    const mode = (job && job.payload && job.payload.mode) || 'create';
    const meta0 = store.isValidId(id) ? store.readMeta(dataDir, id) : null;
    if (!meta0) throw new Error(`workbook ${id} not found`);
    if (!Object.prototype.hasOwnProperty.call(MODE_STEPS, mode)) throw new Error(`unknown workbook job mode: ${mode}`);
    const dir = store.wbDir(dataDir, id);
    const prev = store.readJob(dataDir, id);
    const state = prev && prev.runId === job.id ? prev : initState(job, meta0, prev, mode, now().toISOString());
    state.status = 'running';
    state.error = null;

    const counts = () => {
      const run = Object.values(state.chapters).filter((c) => c.run === state.runId);
      return {
        chaptersDone: run.filter((c) => WRITTEN.has(c.status)).length,
        chaptersFailed: run.filter((c) => c.status === 'failed').length,
        chaptersTotal: run.length,
      };
    };
    const save = () => {
      state.updatedAt = now().toISOString();
      store.writeJob(dataDir, id, state);
      if (ctx && typeof ctx.update === 'function') ctx.update({ workbookId: id, mode, step: state.current, ...counts() });
    };
    const emit = (event) => { if (deps.onEvent) deps.onEvent(event, state); };
    const env = {
      dataDir, id, dir, mode, job, state, save, emit, now,
      runAgent: (args) => dispatchAgent(deps.runAgent || defaultRunAgent, args),
      linkCheck: deps.linkCheck || checkLinks,
      verify: deps.verify || verifyQuestion,
      writerConcurrency: deps.writerConcurrency || 3,
      timeouts: { ...TIMEOUTS, ...(deps.timeouts || {}) },
      profile: (deps.readProfile || readProfileDefault)(dataDir),
      getMeta: () => store.readMeta(dataDir, id),
      setMeta: (patch) => store.writeMeta(dataDir, { ...store.readMeta(dataDir, id), ...patch }, now),
      logFile: (name) => path.join(dir, 'logs', `${name}.log`),
    };

    env.setMeta({ status: 'generating', lastError: null });
    save();
    try {
      for (const step of STEPS) {
        const s = state.steps[step];
        if (s.status === 'done' || s.status === 'skipped') continue;
        const impl = impls[step];
        if (!impl) throw new Error(`no implementation for step ${step}`);
        state.current = step;
        state.steps[step] = { status: 'running', at: now().toISOString() };
        save();
        emit(`step:start:${step}`);
        await impl(env);
        state.steps[step] = { ...state.steps[step], status: 'done', at: now().toISOString() };
        save();
        emit(`step:done:${step}`);
      }
    } catch (err) {
      if (err && err.simulatedCrash) throw err;
      const message = String((err && err.message) || err);
      state.status = 'failed';
      state.error = message;
      if (state.current) state.steps[state.current] = { ...state.steps[state.current], status: 'failed', at: now().toISOString(), error: message.slice(-2000) };
      save();
      env.setMeta({ status: computeStatus(dir, state), lastError: message });
      throw err;
    }
    state.status = 'done';
    state.current = null;
    save();
    const patch = { status: computeStatus(dir, state) };
    if (mode === 'expand' && Object.values(state.chapters).some((c) => c.run === state.runId && c.status === 'published')) patch.tier = 'onsite';
    env.setMeta(patch);
    return { workbookId: id, status: patch.status, ...counts() };
  };
}

module.exports = { createWorkbookHandler, computeStatus, initState, STEPS, MODE_STEPS, TIMEOUTS };
