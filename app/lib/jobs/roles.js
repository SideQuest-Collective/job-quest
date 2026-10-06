// app/lib/jobs/roles.js
const fs = require('fs');
const path = require('path');

function splitRoleKey(roleKey) {
  const i = String(roleKey).indexOf('|');
  if (i === -1) return { company: String(roleKey), role: '' };
  return { company: roleKey.slice(0, i), role: roleKey.slice(i + 1) };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function resolveRole(dataDir, roleKey) {
  const intelDir = path.join(dataDir, 'intel');
  const files = fs.existsSync(intelDir)
    ? fs.readdirSync(intelDir).filter((f) => f.endsWith('.json')).sort().reverse()
    : [];
  for (const f of files) {
    const roles = readJson(path.join(intelDir, f), {}).roles || [];
    const hit = roles.find((r) => `${r.company}|${r.role}` === roleKey);
    if (hit) {
      return { roleKey, company: hit.company, role: hit.role, level: hit.level || null,
        location: hit.location || null, url: hit.url || null, fit: hit.fit || null, source: 'intel' };
    }
  }
  const { company, role } = splitRoleKey(roleKey);
  const tracker = readJson(path.join(dataDir, 'role-tracker.json'), {});
  const t = tracker[roleKey];
  if (t) {
    return { roleKey, company, role, level: t.level || null, location: t.location || null,
      url: t.url || null, fit: t.fit || null, source: 'tracker' };
  }
  return { roleKey, company, role, level: null, location: null, url: null, fit: null, source: 'key' };
}

module.exports = { splitRoleKey, resolveRole };
