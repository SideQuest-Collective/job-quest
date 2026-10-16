// app/lib/podcast/topics.js
// Anticipation, not recollection: the concepts the upcoming interviews are likely to ask, aggregated from the
// questions each live role's workbook chose, merged across roles, ranked by how much the interviews need them,
// and condensed into one concept cheat sheet per topic for the episode writer and the Topics tab.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson, shortHash } = require('./store');
const { activeRoles, workbookIndex, tokens, jaccard } = require('./master');
const { runAgent } = require('../jobs/runner');
const { renderPrompt } = require('../interview/prompts');
const { validateCheatsheet, CATEGORIES } = require('../interview/cheatsheet');

const SHEET_AGENT = 'podcast-topic-sheet';
const GROUPS_AGENT = 'podcast-topic-groups';
const OUT_FILE = 'sheet.out.json';
const GROUPS_OUT_FILE = 'topic-groups.out.json';
const MERGE_THRESHOLD = 0.34;
// Company pitches, logistics and behavioral rounds are not concepts to learn.
const SKIP_TOPIC = /^(company|about the company|culture|logistics|behavio(u)?ral.*|why [a-z].*)$/i;

function topicsFile(dataDir) { return path.join(dataDir, 'podcast', 'topics.json'); }
function topicGroupsFile(dataDir) { return path.join(dataDir, 'podcast', 'topic-groups.json'); }
function namesHash(names) { return crypto.createHash('sha256').update([...names].sort().join('\n')).digest('hex'); }

// Map(raw topic name -> plain concept name) when a cached agent grouping exists for exactly these names.
function readTopicGroups(dataDir, names) {
  const g = readJson(topicGroupsFile(dataDir), null);
  if (!g || g.hash !== namesHash(names)) return null;
  const map = new Map();
  for (const grp of g.groups) for (const m of grp.members) map.set(m, grp.title);
  return map;
}

function bigrams(t) {
  const words = String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const out = new Set();
  for (let i = 0; i + 1 < words.length; i++) if (![...tokens(words[i])].length || ![...tokens(words[i + 1])].length) continue; else out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}
// Same concept, different wording: enough shared words, or a shared two-word phrase like "hash maps".
function sameTopic(a, b) {
  if (a.title.toLowerCase() === b.title.toLowerCase()) return true;
  if (jaccard(a._t, b._t) >= MERGE_THRESHOLD) return true;
  for (const x of a._b) if (b._b.has(x)) return true;
  return false;
}
function topicSheetFile(dataDir, id) {
  if (!/^[a-f0-9]{10}$/.test(String(id))) throw new Error(`invalid topic id: ${id}`);
  return path.join(dataDir, 'podcast', 'topic-sheets', `${id}.json`);
}
function defaultReadWorkbook(dataDir, id) { return require('../interview/workbook-bridge').readWorkbook(dataDir, id); }

function sourceHash(topic) {
  const h = crypto.createHash('sha256');
  for (const q of topic.questions) h.update(`${q.workbookId}|${q.id}|${q.prompt}|${q.answer}\n`);
  for (const c of topic.chapters) h.update(`${c.workbookId}|${c.id}|${c.title}\n`);
  return h.digest('hex').slice(0, 16);
}

function rankTopics(dataDir, { readWorkbook = defaultReadWorkbook, now = new Date() } = {}) {
  const wbs = workbookIndex(dataDir);
  // First pass: every live role's questions and chapters bucketed by the workbook's own topic name.
  const buckets = [];
  for (const r of activeRoles(dataDir)) {
    const wb = wbs.get(r.roleKey);
    if (!wb || (wb.meta && wb.meta.status === 'failed')) continue;
    let book;
    try { book = readWorkbook(dataDir, wb.id); } catch { continue; }
    const byTopic = new Map();
    const bucket = (name) => { if (!byTopic.has(name)) byTopic.set(name, { questions: [], chapters: [] }); return byTopic.get(name); };
    for (const q of book.questions || []) {
      const name = String(q.topic || '').trim();
      if (!name || SKIP_TOPIC.test(name) || !q.prompt) continue;
      bucket(name).questions.push({ workbookId: wb.id, id: q.id, type: q.type, diff: q.diff, chapter: q.chapter, prompt: String(q.prompt), answer: String(q.answer || q.rubric || '').slice(0, 700) });
    }
    for (const c of book.chapters || []) {
      const name = String(c.topic || '').trim();
      if (!name || SKIP_TOPIC.test(name)) continue;
      bucket(name).chapters.push({ workbookId: wb.id, id: c.id, title: c.title, body: String(c.body || '') });
    }
    for (const [name, v] of byTopic) if (v.questions.length) buckets.push({ role: r, rawName: name, ...v });
  }
  // Second pass: the cached agent grouping names the concept; wording heuristics catch the rest.
  const rawNames = [...new Set(buckets.map((b) => b.rawName))];
  const groups = readTopicGroups(dataDir, rawNames) || new Map();
  const merged = [];
  for (const b of buckets) {
    const name = groups.get(b.rawName) || b.rawName;
    const probe = { title: name, _t: tokens(name), _b: bigrams(name) };
    let entry = merged.find((m) => sameTopic(m, probe));
    if (!entry) { entry = { ...probe, roles: new Map(), questions: [], chapters: [], rawNames: new Set() }; merged.push(entry); }
    entry.rawNames.add(b.rawName);
    const r = b.role;
    const prev = entry.roles.get(r.roleKey);
    entry.roles.set(r.roleKey, { roleKey: r.roleKey, company: r.company, stage: r.stage, weight: r.weight, questions: (prev ? prev.questions : 0) + b.questions.length });
    entry.questions.push(...b.questions);
    entry.chapters.push(...b.chapters);
  }
  const topics = merged.map((m) => {
    const roles = [...m.roles.values()];
    // Each role contributes its urgency times how many of its questions sit on this topic; shared topics get a bonus.
    const importance = Math.round(roles.reduce((s, x) => s + x.weight * x.questions, 0) + 10 * (roles.length - 1));
    const topic = { id: shortHash(`topic|${m.title.toLowerCase()}`), title: m.title, rawNames: [...m.rawNames], roles, roleCount: roles.length, questionCount: m.questions.length, importance, questions: m.questions, chapters: m.chapters };
    return { ...topic, sourceHash: sourceHash(topic) };
  }).sort((a, b) => b.importance - a.importance || b.questionCount - a.questionCount || a.title.localeCompare(b.title));
  const out = { builtAt: now.toISOString(), rawNames, grouped: groups.size > 0, topics };
  writeJson(topicsFile(dataDir), { ...out, topics: topics.map((t) => ({ ...t, chapters: t.chapters.map(({ body, ...c }) => c) })) });
  return out;
}

function readRanking(dataDir) { return readJson(topicsFile(dataDir), null); }

function chaptersText(topic) {
  return topic.chapters.filter((c) => c.body).map((c) => `## ${c.title}\n\n${c.body}`).join('\n\n').slice(0, 40000);
}
function questionsText(topic) {
  return topic.questions.slice(0, 25).map((q) => `- ${q.prompt}\n  Strong answer: ${q.answer}`).join('\n');
}

// Chapter bodies are not persisted in topics.json; load them again from the workbooks when building a sheet.
function hydrate(dataDir, topic, readWorkbook) {
  if (topic.chapters.every((c) => typeof c.body === 'string')) return topic;
  const cache = new Map();
  const chapters = topic.chapters.map((c) => {
    if (typeof c.body === 'string') return c;
    if (!cache.has(c.workbookId)) { try { cache.set(c.workbookId, readWorkbook(dataDir, c.workbookId)); } catch { cache.set(c.workbookId, null); } }
    const book = cache.get(c.workbookId);
    const full = book && book.chapters.find((x) => x.id === c.id);
    return { ...c, body: full ? String(full.body || '') : '' };
  });
  return { ...topic, chapters };
}

function readSheet(dataDir, id) {
  const saved = readJson(topicSheetFile(dataDir, id), null);
  if (!saved || !Array.isArray(saved.cards)) return null;
  const v = validateCheatsheet(saved.cards);
  return v.ok ? { ...saved, cards: v.cards } : null;
}

async function buildTopicSheet({ dataDir, topic, readWorkbook = defaultReadWorkbook, runAgentFn = runAgent, timeoutMs = 240000, now = () => new Date() }) {
  const existing = readSheet(dataDir, topic.id);
  if (existing && existing.sourceHash === topic.sourceHash) return { ok: true, cards: existing.cards, cached: true };
  const full = hydrate(dataDir, topic, readWorkbook);
  const dir = path.join(dataDir, 'podcast', 'topic-sheets', 'work', topic.id);
  fs.mkdirSync(dir, { recursive: true });
  const companies = topic.roles.map((r) => r.company).filter(Boolean);
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = path.join(dir, OUT_FILE);
    fs.rmSync(out, { force: true });
    const prompt = renderPrompt('podcast-topic-sheet-agent', {
      topic: topic.title, categories: CATEGORIES.join(', '), chapters: chaptersText(full), questions: questionsText(full),
      errors: errors.length ? `## Your previous file was rejected. Fix these problems:\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
    });
    const run = await runAgentFn({ agent: SHEET_AGENT, prompt, cwd: dir, profile: 'write', timeoutMs, logFile: path.join(dir, 'agent.log'), env: { DATA_DIR: path.resolve(dataDir) } });
    const data = readJson(out, null);
    if (!run.ok && !data) { errors = [run.timedOut ? 'the agent timed out' : `the agent exited with code ${run.code}`]; continue; }
    if (!data) { errors = [`${OUT_FILE} is missing or not valid JSON`]; continue; }
    const v = validateCheatsheet(data);
    if (!v.ok) { errors = v.errors; continue; }
    const named = v.cards.find((c) => companies.some((co) => new RegExp(`\\b${co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(`${c.title} ${c.bullets.join(' ')}`)));
    if (named) { errors = [`card "${named.title}" names a company; the sheet is about the concept, not an employer`]; continue; }
    if (v.cards.length < 3) { errors = [`only ${v.cards.length} cards; a topic needs at least 3`]; continue; }
    const sheet = { id: topic.id, title: topic.title, roleCount: topic.roleCount, questionCount: topic.questionCount, importance: topic.importance, sourceHash: topic.sourceHash, builtAt: now().toISOString(), cards: v.cards };
    writeJson(topicSheetFile(dataDir, topic.id), sheet);
    return { ok: true, cards: v.cards, cached: false };
  }
  return { ok: false, error: `topic-sheet-invalid: ${errors.slice(0, 4).join('; ')}` };
}

function validateTopicGroups(data, names) {
  const known = new Set(names);
  const errors = [];
  if (!Array.isArray(data)) return { ok: false, errors: ['expected a JSON list of groups'] };
  const used = new Set();
  data.forEach((g, i) => {
    if (!g || typeof g.title !== 'string' || !g.title.trim() || !Array.isArray(g.members)) { errors.push(`group ${i + 1}: needs a title and members`); return; }
    if (g.members.length < 2) errors.push(`group ${i + 1}: a group needs at least 2 members`);
    for (const m of g.members) {
      if (!known.has(m)) errors.push(`group ${i + 1}: unknown topic ${JSON.stringify(m).slice(0, 60)}`);
      else if (used.has(m)) errors.push(`group ${i + 1}: topic ${m} is in two groups`);
      used.add(m);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, groups: data.map((g) => ({ title: g.title.trim(), members: g.members })) };
}

// One cheap agent pass names the concept behind differently worded topic names across workbooks. Cached by the set of names.
async function buildTopicGroups({ dataDir, ranking, runAgentFn = runAgent, timeoutMs = 240000 }) {
  const names = ranking && ranking.rawNames ? ranking.rawNames : [];
  if (readTopicGroups(dataDir, names)) return { ok: true, cached: true };
  if (names.length < 2) { writeJson(topicGroupsFile(dataDir), { hash: namesHash(names), groups: [] }); return { ok: true, groups: 0 }; }
  const workDir = path.join(dataDir, 'podcast', 'work', 'topic-groups');
  const sample = new Map();
  for (const t of ranking.topics) for (const q of t.questions) {
    const raw = t.rawNames && t.rawNames.length === 1 ? t.rawNames[0] : null;
    if (raw && !sample.has(raw)) sample.set(raw, q.prompt.slice(0, 120));
  }
  const list = names.map((n) => `${n} | ${sample.get(n) || ''}`).join('\n');
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.mkdirSync(workDir, { recursive: true });
    fs.rmSync(path.join(workDir, GROUPS_OUT_FILE), { force: true });
    const prompt = renderPrompt('podcast-topic-groups-agent', { list, errors: errors.length ? `Your previous file was rejected:\n${errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}` : '' });
    const run = await runAgentFn({ agent: GROUPS_AGENT, prompt, cwd: workDir, profile: 'write', timeoutMs, logFile: path.join(workDir, 'agent.log') });
    const data = readJson(path.join(workDir, GROUPS_OUT_FILE), null);
    if (!run.ok && !data) { errors = ['the agent failed']; continue; }
    const v = validateTopicGroups(data, names);
    if (v.ok) { writeJson(topicGroupsFile(dataDir), { hash: namesHash(names), builtAt: new Date().toISOString(), groups: v.groups }); return { ok: true, groups: v.groups.length }; }
    errors = v.errors;
  }
  return { ok: false, error: errors.slice(0, 3).join('; ') };
}

function missingTopicSheets(dataDir, ranking) {
  return (ranking && ranking.topics ? ranking.topics : []).filter((t) => { const s = readSheet(dataDir, t.id); return !s || s.sourceHash !== t.sourceHash; });
}

async function topUpTopicSheets(dataDir, ranking, limit, log = () => {}, opts = {}) {
  const todo = missingTopicSheets(dataDir, ranking).slice(0, limit);
  for (const t of todo) {
    log(`building topic sheet: ${t.title}`);
    const r = await buildTopicSheet({ dataDir, topic: t, ...opts });
    log(r.ok ? `  done: ${r.cards.length} cards` : `  failed: ${r.error}`);
  }
  return todo.length;
}

// Ranked topics that have a usable sheet, each with its cards and chapter bodies left out.
function readTopicSheets(dataDir, ranking) {
  const out = [];
  for (const t of (ranking && ranking.topics ? ranking.topics : [])) {
    const s = readSheet(dataDir, t.id);
    if (!s) continue;
    const { chapters, ...rest } = t;
    out.push({ ...rest, chapters: chapters.map(({ body, ...c }) => c), cards: s.cards, sheetBuiltAt: s.builtAt, stale: s.sourceHash !== t.sourceHash });
  }
  return out;
}

module.exports = { SHEET_AGENT, GROUPS_AGENT, topicsFile, topicSheetFile, topicGroupsFile, rankTopics, readRanking, readTopicGroups, validateTopicGroups, buildTopicGroups, buildTopicSheet, missingTopicSheets, topUpTopicSheets, readTopicSheets, readSheet };
