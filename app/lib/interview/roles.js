// app/lib/interview/roles.js
// `jq roles --company <name>`: deterministic role lookup over the tracker and role actions.
const fs = require('fs');
const path = require('path');
const { slugify } = require('../jobs/slug');
const { splitRoleKey, resolveRole } = require('../jobs/roles');
const { InputError } = require('./contract');
const bridge = require('./workbook-bridge');
const resumeBridge = require('./resume-bridge');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function companyMatches(company, query) {
  if (!/[a-z0-9]/i.test(String(query || ''))) return false;
  const c = slugify(company);
  const q = slugify(query);
  return c === q || c.startsWith(`${q}-`);
}

function lastActivity(entry) {
  return ((entry && entry.timeline) || []).reduce((m, e) => (e && e.date && String(e.date) > m ? String(e.date) : m), '');
}

function listRolesForCompany(dataDir, company) {
  if (!/[a-z0-9]/i.test(String(company || ''))) throw new InputError('roles needs --company <name>');
  const tracker = readJson(path.join(dataDir, 'role-tracker.json'), {});
  const actions = readJson(path.join(dataDir, 'role-actions.json'), {});
  const applied = actions.applied || [];
  const keys = new Set([...Object.keys(tracker), ...(actions.saved || []), ...applied]);
  return [...keys]
    .filter((k) => typeof k === 'string' && k.includes('|') && companyMatches(splitRoleKey(k).company, company))
    .map((k) => {
      const { company: co, role } = splitRoleKey(k);
      const t = tracker[k];
      const tailored = resumeBridge.findTailored(dataDir, k);
      return {
        roleKey: k, company: co, role,
        stage: (t && t.stage) || (applied.includes(k) ? 'applied' : 'saved'),
        hasWorkbook: !!bridge.findWorkbook(dataDir, k),
        hasTailoredResume: !!(tailored && tailored.done),
        last: lastActivity(t),
      };
    })
    .sort((a, b) => {
      if (a.last !== b.last) return a.last > b.last ? -1 : 1;
      return a.roleKey < b.roleKey ? -1 : a.roleKey > b.roleKey ? 1 : 0;
    })
    .map(({ last, ...row }) => row);
}

function isKnownRole(dataDir, roleKey) {
  const tracker = readJson(path.join(dataDir, 'role-tracker.json'), {});
  const actions = readJson(path.join(dataDir, 'role-actions.json'), {});
  if (tracker[roleKey] || (actions.saved || []).includes(roleKey) || (actions.applied || []).includes(roleKey)) return true;
  return resolveRole(dataDir, roleKey).source === 'intel';
}

module.exports = { companyMatches, listRolesForCompany, isKnownRole };
