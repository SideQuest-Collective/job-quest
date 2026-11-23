// app/lib/workbook/autobuild.js
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { readSettings } = require('../jobs/settings');
const { resolveRole } = require('../jobs/roles');

function createAutoBuild({ dataDir, queue, now = () => new Date() }) {
  // research: optional research.md text the caller already gathered (it must cite sources); the build
  // then skips its own web research. It is written before the job is queued, which may start it at once.
  function enqueueWorkbook(roleKey, { trigger = 'manual', auto = false, ignoreSwitch = false, research = null } = {}) {
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
    if (research) {
      fs.writeFileSync(path.join(store.wbDir(dataDir, meta.id), 'research.md'), research.endsWith('\n') ? research : `${research}\n`);
      meta = store.writeMeta(dataDir, { ...meta, researched: true, researchSource: 'supplied' }, now);
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

  // Only an accepted tailored resume triggers an automatic build; saving or applying alone does not.
  function onRoleEvent(event, roleKey) {
    if (event !== 'accepted') return { status: 'ignored' };
    return enqueueWorkbook(roleKey, { trigger: 'auto-accepted', auto: true });
  }

  // Roles with an accepted tailored resume, skipping ones the tracker has closed out.
  function acceptedResumeKeys() {
    const tailored = path.join(dataDir, 'resume', 'tailored');
    const tracker = store.readJsonFile(path.join(dataDir, 'role-tracker.json'), {}) || {};
    let dirs = [];
    try { dirs = fs.readdirSync(tailored); } catch { return []; }
    const keys = [];
    for (const d of dirs.sort()) {
      const meta = store.readJsonFile(path.join(tailored, d, 'meta.json'), null);
      if (!meta || !meta.accepted) continue;
      for (const k of meta.roleKeys || []) {
        if (typeof k !== 'string' || !k.includes('|') || keys.includes(k)) continue;
        if (tracker[k] && tracker[k].stage === 'rejected') continue;
        keys.push(k);
      }
    }
    return keys;
  }

  function backfillCandidates() {
    return acceptedResumeKeys().filter((k) => {
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
