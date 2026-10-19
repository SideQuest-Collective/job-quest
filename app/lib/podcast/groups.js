// app/lib/podcast/groups.js
// One cheap agent pass groups cheat-sheet cards that teach the same idea under different titles
// ("The six-step coding loop" at Citadel, "The loop to run on every question" at Harvey).
// Code owns the merge; the agent only returns groups of card keys. Cached by the set of keys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runAgent } = require('../jobs/runner');
const { renderPrompt } = require('../interview/prompts');
const { podcastDir, readJson, writeJson } = require('./store');

const OUT_FILE = 'groups.out.json';
function groupsFile(dataDir) { return path.join(podcastDir(dataDir), 'concept-groups.json'); }
function keysHash(keys) { return crypto.createHash('sha256').update([...keys].sort().join('\n')).digest('hex'); }

// Returns Map(cardKey -> group title) when a valid cached grouping exists for exactly these cards.
function readGroups(dataDir, keys) {
  const g = readJson(groupsFile(dataDir), null);
  if (!g || g.hash !== keysHash(keys)) return null;
  const map = new Map();
  for (const grp of g.groups) for (const k of grp.members) map.set(k, grp.title);
  return map;
}

function validateGroups(data, keys) {
  const known = new Set(keys);
  const errors = [];
  if (!Array.isArray(data)) return { ok: false, errors: ['expected a JSON list of groups'] };
  const used = new Set();
  data.forEach((g, i) => {
    if (!g || typeof g.title !== 'string' || !Array.isArray(g.members)) { errors.push(`group ${i + 1}: needs title and members`); return; }
    if (g.members.length < 2) errors.push(`group ${i + 1}: a group needs at least 2 members`);
    for (const m of g.members) {
      if (!known.has(m)) errors.push(`group ${i + 1}: unknown key ${JSON.stringify(m).slice(0, 40)}`);
      else if (used.has(m)) errors.push(`group ${i + 1}: key ${m} is in two groups`);
      used.add(m);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, groups: data.map((g) => ({ title: g.title.trim(), members: g.members })) };
}

async function buildGroups({ dataDir, cards, runAgentFn = runAgent, timeoutMs = 240000 }) {
  const keys = cards.map((c) => c.key);
  if (readGroups(dataDir, keys)) return { ok: true, cached: true };
  const companies = new Set(cards.map((c) => c.company));
  if (companies.size < 2) { writeJson(groupsFile(dataDir), { hash: keysHash(keys), groups: [] }); return { ok: true, groups: 0 }; }
  const workDir = path.join(podcastDir(dataDir), 'work', 'groups');
  const list = cards.map((c) => `${c.key} | ${c.company} | ${c.category} | ${c.title} | ${String(c.bullets[0] || '').slice(0, 160)}`).join('\n');
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.mkdirSync(workDir, { recursive: true });
    fs.rmSync(path.join(workDir, OUT_FILE), { force: true });
    const prompt = renderPrompt('podcast-groups-agent', { list, errors: errors.length ? `Your previous file was rejected:\n${errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}` : '' });
    const run = await runAgentFn({ agent: 'podcast-groups', prompt, cwd: workDir, profile: 'write', timeoutMs, logFile: path.join(workDir, 'agent.log') });
    if (!run.ok) { errors = ['the agent failed']; continue; }
    const v = validateGroups(readJson(path.join(workDir, OUT_FILE), null), keys);
    if (v.ok) { writeJson(groupsFile(dataDir), { hash: keysHash(keys), builtAt: new Date().toISOString(), groups: v.groups }); return { ok: true, groups: v.groups.length }; }
    errors = v.errors;
  }
  return { ok: false, error: errors.slice(0, 3).join('; ') };
}

module.exports = { readGroups, validateGroups, buildGroups, keysHash, groupsFile };
