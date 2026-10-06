// app/lib/workbook/autobuild.js
const path = require('path');
const store = require('./store');
const { readSettings } = require('../jobs/settings');
const { resolveRole } = require('../jobs/roles');

function createAutoBuild({ dataDir, queue, now = () => new Date() }) {
  function enqueueWorkbook(roleKey, { trigger = 'manual', auto = false, ignoreSwitch = false } = {}) {
    if (typeof roleKey !== 'string' || !roleKey.includes('|')) return { status: 'invalid' };
    const existing = store.findByRoleKey(dataDir, roleKey);
    // An interview-only workbook (P3) does not count: generation runs into that same directory.
    if (existing && existing.source !== 'interview') return { status: 'exists', workbook: existing };
    const settings = readSettings(dataDir).workbooks;
    if (auto && !ignoreSwitch && !settings.autoBuild) return { status: 'disabled' };
    let meta;
    if (existing) {
      meta = store.writeMeta(dataDir, { ...existing, source: 'generated', status: 'queued', trigger, researched: false }, now);
    } else {
      const role = resolveRole(dataDir, roleKey);
      meta = store.createWorkbook(dataDir, { roleKeys: [roleKey], company: role.company, role: role.role, trigger }, now);
    }
    const r = queue.enqueue(
      { kind: 'workbook', key: `workbook:${meta.id}`, payload: { workbookId: meta.id, mode: 'create' } },
      auto ? { auto: true, capName: 'workbooks', cap: settings.autoDailyCap } : {},
    );
    // Enqueue may synchronously start a handler, so keep its latest metadata.
    meta = store.readMeta(dataDir, meta.id);
    if (r.status === 'deferred' || (r.status === 'duplicate' && existing)) {
      meta = store.writeMeta(dataDir, { ...meta, status: r.status === 'duplicate' ? existing.status : 'deferred' }, now);
    }
    return { status: r.status, workbook: meta, jobId: r.id };
  }

  function onRoleEvent(event, roleKey) {
    return enqueueWorkbook(roleKey, { trigger: event === 'applied' ? 'auto-applied' : 'auto-saved', auto: true });
  }

  function savedAndAppliedKeys() {
    const actions = store.readJsonFile(path.join(dataDir, 'role-actions.json'), {}) || {};
    const tracker = store.readJsonFile(path.join(dataDir, 'role-tracker.json'), {}) || {};
    const keys = [];
    const add = (k) => { if (typeof k === 'string' && k.includes('|') && !keys.includes(k)) keys.push(k); };
    (actions.saved || []).forEach(add);
    (actions.applied || []).forEach(add);
    for (const [k, v] of Object.entries(tracker)) if (v && v.stage === 'applied') add(k);
    return keys;
  }

  function backfillCandidates() {
    return savedAndAppliedKeys().filter((k) => {
      const w = store.findByRoleKey(dataDir, k);
      return !w || w.source === 'interview';
    });
  }

  function backfill() {
    return backfillCandidates().map((roleKey) => ({ roleKey, ...enqueueWorkbook(roleKey, { trigger: 'backfill', auto: true, ignoreSwitch: true }) }));
  }

  return { enqueueWorkbook, onRoleEvent, backfill, backfillCandidates };
}

module.exports = { createAutoBuild };
