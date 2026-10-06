// app/lib/workbook/store.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('../interview/atomic');
const { roleSlug, slugify } = require('../jobs/slug');
const { splitRoleKey } = require('../jobs/roles');
const { parseContentDir, escapeRe } = require('./parse');
const { mergeGlossaries, loadNolink } = require('./glossary');
const { emptyProgress, mergeProgress, normalizeProgress, summarize } = require('./progress');

const NOLINK_FILE = path.resolve(__dirname, '..', '..', '..', 'skill', 'references', 'workbook', 'nolink.txt');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,89}$/;
const ASKED = { id: 'asked-in-interviews', file: '99-asked-in-interviews.md', title: 'Asked in your interviews', topic: 'Interviews' };

function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }
function rootDir(dataDir) { return path.join(dataDir, 'workbooks'); }
function wbDir(dataDir, id) {
  if (!isValidId(id)) throw new Error(`invalid workbook id: ${id}`);
  return path.join(rootDir(dataDir), id);
}
function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

function listIds(dataDir) {
  const root = rootDir(dataDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => isValidId(n) && fs.existsSync(path.join(root, n, 'meta.json'))).sort();
}
function readMeta(dataDir, id) {
  if (!isValidId(id)) return null;
  return readJsonFile(path.join(rootDir(dataDir), id, 'meta.json'), null);
}
function writeMeta(dataDir, meta, now = () => new Date()) {
  const next = { ...meta, updatedAt: now().toISOString() };
  writeJsonAtomic(path.join(wbDir(dataDir, meta.id), 'meta.json'), next);
  return next;
}
function listWorkbooks(dataDir) {
  return listIds(dataDir).map((id) => readMeta(dataDir, id)).filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.id.localeCompare(b.id));
}
function findByRoleKey(dataDir, roleKey) {
  return listWorkbooks(dataDir).find((m) => (m.roleKeys || []).includes(roleKey)) || null;
}
function companyNamesFor(roleKeys) {
  const out = {};
  for (const k of roleKeys) {
    const { company } = splitRoleKey(k);
    if (company) out[slugify(company)] = company;
  }
  return out;
}

function createWorkbook(dataDir, opts, now = () => new Date()) {
  const roleKeys = (opts.roleKeys || []).filter((k) => typeof k === 'string' && k.includes('|'));
  if (!roleKeys.length) throw new Error('createWorkbook needs at least one "Company|Role" roleKey');
  const first = splitRoleKey(roleKeys[0]);
  const company = opts.company || first.company;
  const role = opts.role || first.role;
  const root = rootDir(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const id = roleSlug(company, role, (s) => fs.existsSync(path.join(root, s)));
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  const at = now().toISOString();
  const meta = {
    id, title: opts.title || `${company}: ${role}`, roleKeys, company, role,
    companyNames: { ...companyNamesFor(roleKeys), ...(opts.companyNames || {}) },
    tier: opts.tier || 'screen', status: opts.status || 'queued', source: opts.source || 'generated',
    researched: opts.researched === undefined ? false : opts.researched,
    createdAt: at, updatedAt: at, trigger: opts.trigger || 'manual',
  };
  writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  writeJsonAtomic(path.join(dir, 'progress.json'), emptyProgress());
  return meta;
}

function deleteWorkbook(dataDir, id) { fs.rmSync(wbDir(dataDir, id), { recursive: true, force: true }); }
function readJob(dataDir, id) { return readJsonFile(path.join(wbDir(dataDir, id), 'job.json'), null); }
function writeJob(dataDir, id, state) { writeJsonAtomic(path.join(wbDir(dataDir, id), 'job.json'), state); }
function readProgress(dataDir, id) { return normalizeProgress(readJsonFile(path.join(wbDir(dataDir, id), 'progress.json'), null)); }
function writeProgress(dataDir, id, incoming) {
  const merged = mergeProgress(readProgress(dataDir, id), incoming);
  writeJsonAtomic(path.join(wbDir(dataDir, id), 'progress.json'), merged);
  return merged;
}
function writeGrades(dataDir, id, grades) {
  if (!readMeta(dataDir, id)) throw new Error(`workbook ${id} not found`);
  const known = new Set(loadParsed(dataDir, id).questions.map((q) => q.id));
  const accepted = [], rejected = [];
  // Validate every entry before touching progress; one malformed entry must not
  // discard the remaining grades from an agent-parsed interview debrief.
  for (const g of Array.isArray(grades) ? grades : [grades]) {
    const qid = g && typeof g.qid === 'string' ? g.qid : null;
    const at = g && typeof g.at === 'string' ? Date.parse(g.at) : NaN;
    const reason = !g || typeof g !== 'object' ? 'expected a grade object'
      : !['got', 'partial', 'missed'].includes(g.grade) ? 'grade must be got, partial, or missed'
      : !Number.isFinite(at) ? 'at must be a parseable timestamp'
      : !known.has(qid) ? 'question does not exist in this workbook' : null;
    if (reason) rejected.push({ qid, reason });
    else accepted.push({ ...g, at: new Date(at).toISOString() });
  }
  let progress = readProgress(dataDir, id);
  for (const g of accepted) progress = mergeProgress(progress, { grades: { [g.qid]: { grade: g.grade, at: g.at, source: g.source } } });
  writeJsonAtomic(path.join(wbDir(dataDir, id), 'progress.json'), progress);
  return { progress, recorded: accepted.map((g) => g.qid), rejected };
}

function loadParsed(dataDir, id) { return parseContentDir(path.join(wbDir(dataDir, id), 'content')); }
function nolinkFor(meta) {
  const set = new Set(loadNolink(NOLINK_FILE));
  for (const [slug, name] of Object.entries((meta && meta.companyNames) || {})) {
    set.add(slug.toLowerCase());
    set.add(String(name).toLowerCase());
  }
  if (meta && meta.company) set.add(String(meta.company).toLowerCase());
  return set;
}
function isSystemDesign(q) { return /^system design$/i.test(String(q.topic || '').trim()); }
function sdTopicId(id, qid) { return `wb-${crypto.createHash('sha1').update(`${id}:${qid}`).digest('hex').slice(0, 12)}`; }
// Code questions whose @@tests passed verification are offered in Code Lab under this id.
function codeProblemId(id, qid) { return `wb-code-${crypto.createHash('sha1').update(`${id}:${qid}`).digest('hex').slice(0, 12)}`; }
function passingQids(dataDir, id) {
  const v = readJsonFile(path.join(wbDir(dataDir, id), 'verify.json'), null);
  const out = new Set();
  for (const list of Object.values((v && v.chapters) || {})) {
    for (const r of Array.isArray(list) ? list : []) if (r && r.pass === true && typeof r.qid === 'string') out.add(r.qid);
  }
  return out;
}

function viewerContent(dataDir, id) {
  const meta = readMeta(dataDir, id);
  const parsed = loadParsed(dataDir, id);
  const passing = passingQids(dataDir, id);
  return {
    chapters: parsed.chapters.map((c) => ({ id: c.id, company: c.company || 'both', topic: c.topic, title: c.title, mins: c.mins, sub: c.sub, body: c.body, file: c.file })),
    questions: parsed.questions.map((q) => {
      const o = { id: q.id, company: q.company || 'both', topic: q.topic, type: q.type, diff: q.diff, chapter: q.chapter, body: q.body,
        choices: q.choices || '', hint: q.hint || '', rubric: q.rubric || '', answer: q.answer || '', file: q.file };
      if (isSystemDesign(q)) o.sdTopicId = sdTopicId(id, q.id);
      if (q.type === 'code' && passing.has(q.id)) o.codeProblemId = codeProblemId(id, q.id);
      return o;
    }),
    glossary: mergeGlossaries(parsed.glossaryFiles, nolinkFor(meta)),
  };
}
function summary(dataDir, id) { return summarize(loadParsed(dataDir, id).questions, readProgress(dataDir, id)); }

function createMinimalWorkbook(dataDir, { roleKey, company, role, title, source = 'interview' }, now = () => new Date()) {
  const existing = findByRoleKey(dataDir, roleKey);
  if (existing) return existing;
  return createWorkbook(dataDir, { roleKeys: [roleKey], company, role, title, source, trigger: 'interview', status: 'ready', researched: null }, now);
}
function writeChapterFile(dataDir, id, filename, markdown) {
  if (!readMeta(dataDir, id)) throw new Error(`workbook ${id} not found`);
  if (!/^(\d{2}-[a-z0-9-]+\.md|glossary-[a-z0-9-]+\.txt)$/.test(String(filename))) throw new Error(`invalid chapter file name: ${filename}`);
  const file = path.join(wbDir(dataDir, id), 'content', filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(markdown));
  return file;
}
function askedChapterText(meta, intro) {
  const company = Object.keys(meta.companyNames || {})[0] || 'both';
  return [
    `@@chapter id=${ASKED.id} company=${company} topic="${ASKED.topic}" title="${ASKED.title}"`,
    '## In plain English', '', intro.trim(), '',
    '## Key takeaways', '',
    '- Re-answer each question below until you can grade it Got it.',
    '- Missed and partial questions come back through the interview trainer on a spaced schedule.',
    '',
  ].join('\n');
}
function appendChapterQuestions(dataDir, id, { intro, questions }, now = () => new Date()) {
  const meta = readMeta(dataDir, id);
  if (!meta) throw new Error(`workbook ${id} not found`);
  const file = path.join(wbDir(dataDir, id), 'content', ASKED.file);
  const exists = fs.existsSync(file);
  let text = exists ? fs.readFileSync(file, 'utf-8') : askedChapterText(meta, intro || 'Questions you were asked in real interviews, graded from each debrief.');
  if (exists && intro) text = text.replace(/(## In plain English\n)[\s\S]*?(\n## Key takeaways)/, (m, a, b) => `${a}\n${intro.trim()}\n${b}`);
  const known = new Set(loadParsed(dataDir, id).questions.map((q) => q.id));
  const appended = [];
  const skipped = [];
  for (const q of questions || []) {
    if (!q || typeof q.id !== 'string' || typeof q.markup !== 'string') throw new Error('each question needs { id, markup }');
    if (known.has(q.id)) { skipped.push(q.id); continue; }
    if (!new RegExp(`^@@q\\s+id=${escapeRe(q.id)}(\\s|$)`).test(q.markup.trim())) throw new Error(`markup for ${q.id} must start with "@@q id=${q.id}"`);
    text = `${text.replace(/\s*$/, '')}\n\n${q.markup.trim()}\n`;
    known.add(q.id);
    appended.push(q.id);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  writeMeta(dataDir, meta, now);
  return { file: ASKED.file, chapterId: ASKED.id, appended, skipped };
}

module.exports = {
  codeProblemId, passingQids,
  ASKED, companyNamesFor, isValidId, rootDir, wbDir, readJsonFile, writeJsonAtomic,
  createWorkbook, readMeta, writeMeta, listWorkbooks, findByRoleKey, deleteWorkbook,
  readJob, writeJob, readProgress, writeProgress, writeGrades,
  loadParsed, nolinkFor, isSystemDesign, sdTopicId, viewerContent, summary,
  createMinimalWorkbook, appendChapterQuestions, writeChapterFile,
  createMinimal: createMinimalWorkbook, recordGrades: writeGrades,
};
