// app/lib/podcast/master.js
// The master cheat sheet: every per-role cheat sheet merged into one deck.
// Cards that teach the same idea for several companies collapse into one card tagged with all of them.
// Grouping comes from the cached agent pass (groups.js) when present, with a word-overlap fallback.
const fs = require('fs');
const path = require('path');
const { readJson, shortHash } = require('./store');
const { slugify } = require('../jobs/slug');
const { readGroups } = require('./groups');

const STAGE_WEIGHT = { offer: 6, onsite: 5, 'phone-screen': 4, applied: 2, researching: 2, discovered: 1, saved: 1, rejected: 0 };
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'your', 'you', 'is', 'it', 'at', 'vs', 'how', 'what', 'why']);

function tokens(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

// Roles worth studying: tracked and not rejected, or saved. Returns [{roleKey, company, role, stage, weight}].
function activeRoles(dataDir) {
  const tracker = readJson(path.join(dataDir, 'role-tracker.json'), {});
  const actions = readJson(path.join(dataDir, 'role-actions.json'), {});
  const out = new Map();
  for (const [key, v] of Object.entries(tracker)) {
    const stage = v && v.stage;
    if (!stage || stage === 'rejected') continue;
    out.set(key, { roleKey: key, stage, weight: STAGE_WEIGHT[stage] ?? 1 });
  }
  for (const key of actions.saved || []) if (!out.has(key)) out.set(key, { roleKey: key, stage: 'saved', weight: 1 });
  return [...out.values()].map((r) => {
    const [company, ...rest] = r.roleKey.split('|');
    return { ...r, company, role: rest.join('|') };
  });
}

// Workbooks on disk, keyed by roleKey. A workbook id doubles as the cheat-sheet folder name.
function workbookIndex(dataDir) {
  const dir = path.join(dataDir, 'workbooks');
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const id of fs.readdirSync(dir)) {
    const meta = readJson(path.join(dir, id, 'meta.json'), null);
    if (!meta) continue;
    for (const key of meta.roleKeys || []) map.set(key, { id, meta });
  }
  return map;
}

function cheatsheetFile(dataDir, id) { return path.join(dataDir, 'interview-work', 'cheatsheets', id, 'cheatsheet.json'); }

// A role's sheet lives under its workbook id, or under the slug of "company role" for sheets
// built straight from the interview flow.
function sheetIdFor(dataDir, roleKey, wbs) {
  const wb = wbs.get(roleKey);
  if (wb && fs.existsSync(cheatsheetFile(dataDir, wb.id))) return wb.id;
  const [company, ...rest] = roleKey.split('|');
  const slug = slugify(`${company} ${rest.join(' ')}`);
  return fs.existsSync(cheatsheetFile(dataDir, slug)) ? slug : null;
}

// Active roles with a workbook but no cheat sheet yet, most urgent first.
function missingSheets(dataDir) {
  const wbs = workbookIndex(dataDir);
  return activeRoles(dataDir)
    .filter((r) => wbs.has(r.roleKey) && wbs.get(r.roleKey).meta.status !== 'failed' && !sheetIdFor(dataDir, r.roleKey, wbs))
    .map((r) => ({ ...r, workbookId: wbs.get(r.roleKey).id }))
    .sort((a, b) => b.weight - a.weight);
}

// Every card of every active role's sheet, with a stable key "<sheetId>#<rank>".
function rawCards(dataDir) {
  const wbs = workbookIndex(dataDir);
  const sources = [];
  const cards = [];
  for (const r of activeRoles(dataDir).sort((a, b) => b.weight - a.weight)) {
    const id = sheetIdFor(dataDir, r.roleKey, wbs);
    const sheet = id && readJson(cheatsheetFile(dataDir, id), null);
    if (!sheet || !Array.isArray(sheet.cards)) continue;
    sources.push({ roleKey: r.roleKey, company: r.company, stage: r.stage, cards: sheet.cards.length, builtAt: sheet.builtAt || null });
    sheet.cards.forEach((card, rank) => cards.push({ ...card, key: `${id}#${rank}`, roleKey: r.roleKey, company: r.company, stage: r.stage, weight: r.weight, rank }));
  }
  return { sources, cards };
}

function buildMaster(dataDir, { threshold = 0.5 } = {}) {
  const { sources, cards: raw } = rawCards(dataDir);
  const groups = readGroups(dataDir, raw.map((c) => c.key));
  const merged = [];
  const byGroup = new Map();
  for (const c of raw) {
    const tag = { roleKey: c.roleKey, company: c.company, stage: c.stage, weight: c.weight, rank: c.rank, title: c.title };
    const g = groups && groups.get(c.key);
    let twin = g ? byGroup.get(g) : null;
    if (!twin && !g) {
      const t = tokens(c.title);
      twin = merged.find((m) => !m._group && m.category === c.category && jaccard(m._t, t) >= threshold);
    }
    if (twin) { twin.roles.push(tag); continue; }
    const { key, roleKey, company, stage, weight, rank, ...card } = c;
    const entry = { ...card, ...(g ? { title: g, _group: g } : {}), roles: [tag], _t: tokens(c.title) };
    merged.push(entry);
    if (g) byGroup.set(g, entry);
  }
  const cards = merged.map(({ _t, _group, ...c }) => {
    const weight = Math.max(...c.roles.map((x) => x.weight));
    const bestRank = Math.min(...c.roles.map((x) => x.rank));
    const companies = [...new Set(c.roles.map((x) => x.company))];
    return {
      id: shortHash(`${c.category}|${c.title}`),
      ...c,
      companies,
      shared: companies.length > 1,
      // Higher = more worth knowing: urgent stage, shared across companies, ranked early in its sheet.
      priority: Math.round((weight * 10 + (companies.length - 1) * 8 + Math.max(0, 20 - bestRank)) * 10) / 10,
    };
  }).sort((a, b) => b.priority - a.priority);
  return { builtAt: new Date().toISOString(), grouped: !!groups, sources, missing: missingSheets(dataDir).map(({ roleKey, stage }) => ({ roleKey, stage })), cards };
}

module.exports = { STAGE_WEIGHT, activeRoles, workbookIndex, sheetIdFor, missingSheets, rawCards, buildMaster, tokens, jaccard };
