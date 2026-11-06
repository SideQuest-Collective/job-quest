#!/usr/bin/env node
// app/lib/jobs/handled-roles-cli.js
// Daily-runner helper. Reads only; the one write is `filter`, which rewrites today's Intel report.
//   list <dataDir> <outFile>     write the roles the user already skipped/saved/applied/tracked (Company | Title | URL)
//   filter <dataDir> <intelFile> move roles matching that list out of `roles` into `suppressedRoles`
const fs = require('node:fs');
const path = require('node:path');
const identity = require('./role-identity');
const roleHistory = require('./role-history');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// Ledger entries (or an in-memory seed when no ledger exists yet) plus current state keys.
function handledRoles(dataDir) {
  const actions = readJson(path.join(dataDir, 'role-actions.json'), {});
  const tracker = readJson(path.join(dataDir, 'role-tracker.json'), {});
  const history = roleHistory.readHistory(dataDir)
    || roleHistory.buildSeed(dataDir, { saved: actions.saved || [], skipped: actions.skipped || [], applied: actions.applied || [] }, tracker, new Date().toISOString());
  const entries = roleHistory.handledEntries(history, actions, tracker);
  const urls = roleHistory.intelUrlIndex(dataDir);
  const byKey = new Map();
  for (const entry of entries) {
    const known = byKey.get(entry.key);
    const url = entry.url || known?.url || urls.get(entry.key) || null;
    byKey.set(entry.key, { ...known, ...entry, url, action: known && known.action !== 'current' ? known.action : entry.action });
  }
  return [...byKey.values()];
}

function listHandled(dataDir, outFile) {
  const roles = handledRoles(dataDir).sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  const lines = roles.map(role => `${role.company} | ${role.title} | ${role.url ? identity.canonicalPostingUrl(role.url) || role.url : '-'}`);
  fs.writeFileSync(outFile, `${lines.join('\n')}\n`);
  return roles.length;
}

function filterIntel(dataDir, intelFile, now = new Date().toISOString()) {
  const report = JSON.parse(fs.readFileSync(intelFile, 'utf8'));
  if (!report || !Array.isArray(report.roles)) return { kept: 0, suppressed: 0 };
  const index = identity.createRoleIndex(handledRoles(dataDir));
  const kept = [], suppressed = [];
  for (const role of report.roles) {
    const hit = role && typeof role === 'object' ? index.match(role) : null;
    if (hit) suppressed.push({ ...role, suppressedReason: 'already-handled', matchedKey: hit.key, suppressedAt: now });
    else kept.push(role);
  }
  if (suppressed.length) {
    const next = { ...report, roles: kept, suppressedRoles: [...(Array.isArray(report.suppressedRoles) ? report.suppressedRoles : []), ...suppressed] };
    const tmp = `${intelFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, intelFile);
  }
  return { kept: kept.length, suppressed: suppressed.length, matches: suppressed.map(role => `${identity.roleKeyOf(role)} -> ${role.matchedKey}`) };
}

if (require.main === module) {
  const [command, dataDir, file] = process.argv.slice(2);
  try {
    if (command === 'list' && dataDir && file) console.log(listHandled(dataDir, file));
    else if (command === 'filter' && dataDir && file) {
      const result = filterIntel(dataDir, file);
      console.log(`kept ${result.kept}, suppressed ${result.suppressed}${result.matches?.length ? `: ${result.matches.join('; ')}` : ''}`);
    } else { console.error('usage: handled-roles-cli.js list <dataDir> <outFile> | filter <dataDir> <intelFile>'); process.exit(64); }
  } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { handledRoles, listHandled, filterIntel };
