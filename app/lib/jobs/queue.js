// app/lib/jobs/queue.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getLocalDateStamp } = require('../local-date');

const ACTIVE = new Set(['queued', 'running', 'deferred']);

function createQueue({ dataDir, handlers, now = () => new Date() }) {
  const dir = path.join(dataDir, 'jobs');
  const file = path.join(dir, 'queue.json');
  let state = { jobs: [], counts: {} };
  try { state = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  state.jobs = state.jobs || [];
  state.counts = state.counts || {};
  for (const j of state.jobs) if (j.status === 'running') j.status = 'queued';
  save();

  let draining = null;

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  function today() { return getLocalDateStamp(now()); }

  function countFor(capName) {
    return (state.counts[today()] || {})[capName] || 0;
  }

  function bump(capName) {
    const d = today();
    state.counts[d] = state.counts[d] || {};
    state.counts[d][capName] = (state.counts[d][capName] || 0) + 1;
  }

  function enqueue(job, opts = {}) {
    const dup = state.jobs.find((j) => j.key === job.key && ACTIVE.has(j.status));
    if (dup) return { id: dup.id, status: 'duplicate' };
    const record = {
      id: crypto.randomUUID(), kind: job.kind, key: job.key, payload: job.payload || {},
      status: 'queued', createdAt: now().toISOString(), startedAt: null, finishedAt: null,
      error: null, result: null, progress: null,
      cap: opts.auto ? { name: opts.capName, limit: opts.cap } : null,
    };
    if (opts.auto) {
      if (countFor(opts.capName) >= opts.cap) record.status = 'deferred';
      else bump(opts.capName);
    }
    state.jobs.push(record);
    save();
    const status = record.status;
    if (status === 'queued') kick();
    return { id: record.id, status };
  }

  function promoteDeferred() {
    const deferred = state.jobs.filter((j) => j.status === 'deferred')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const j of deferred) {
      if (countFor(j.cap.name) < j.cap.limit) {
        bump(j.cap.name);
        j.status = 'queued';
      }
    }
    save();
  }

  async function runAll() {
    for (;;) {
      const next = state.jobs.find((j) => j.status === 'queued');
      if (!next) return;
      next.status = 'running';
      next.startedAt = now().toISOString();
      save();
      const ctx = { update(patch) { next.progress = { ...(next.progress || {}), ...patch }; save(); } };
      try {
        const handler = handlers[next.kind];
        if (!handler) throw new Error(`no handler for kind ${next.kind}`);
        next.result = (await handler(next, ctx)) ?? null;
        next.status = 'done';
      } catch (err) {
        next.status = 'failed';
        next.error = String(err && err.stack ? err.message : err);
      }
      next.finishedAt = now().toISOString();
      save();
    }
  }

  function kick() {
    if (!draining) draining = runAll().finally(() => { draining = null; });
    return draining;
  }

  async function drain() {
    while (draining || state.jobs.some((j) => j.status === 'queued')) await kick();
  }

  async function tick() {
    promoteDeferred();
    await drain();
  }

  return {
    enqueue,
    list: () => state.jobs.slice(),
    get: (id) => state.jobs.find((j) => j.id === id) || null,
    findActiveByKey: (key) => state.jobs.find((j) => j.key === key && ACTIVE.has(j.status)) || null,
    start: () => { kick(); },
    drain,
    tick,
  };
}

module.exports = { createQueue };
