// app/lib/interview/workbook-bridge.js
// The ONLY file in app/lib/interview that touches P1's workbook modules.
// If P1 named an export differently, change the call here and nowhere else.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../workbook/store');
const parse = require('../workbook/parse');
const lint = require('../workbook/lint');
const { CHAPTER_ID } = require('./workbook-markup');

const INTERVIEW_CHAPTER_ID = CHAPTER_ID;
const INTERVIEW_CHAPTER_FILE = '99-asked-in-interviews.md';

function findWorkbook(dataDir, roleKey) {
  const meta = store.findByRoleKey(dataDir, roleKey);
  return meta ? { id: meta.id, dir: store.wbDir(dataDir, meta.id), meta } : null;
}

function ensureWorkbook(dataDir, { roleKey, company, role }) {
  const found = findWorkbook(dataDir, roleKey);
  if (found) return { ...found, created: false };
  const meta = store.createWorkbook(dataDir, {
    roleKeys: [roleKey], company, role, title: `${company}: ${role}`,
    tier: 'screen', status: 'ready', source: 'interview', trigger: 'interview', researched: null,
  });
  return { id: meta.id, dir: store.wbDir(dataDir, meta.id), meta, created: true };
}

function workbookExists(dataDir, id) {
  return store.isValidId(id) && fs.existsSync(path.join(store.wbDir(dataDir, id), 'meta.json'));
}

function normalizeQuestion(q) {
  return {
    id: String(q.id),
    chapter: q.chapter || null,
    topic: q.topic || '',
    type: q.type || 'open',
    diff: Number(q.diff) || 2,
    prompt: String(q.body || '').trim(),
    choices: parse.parseChoices(q.choices).map((c) => c.text),
    rubric: String(q.rubric || '').trim(),
    answer: String(q.answer || '').trim(),
  };
}

function readWorkbook(dataDir, id) {
  const parsed = store.loadParsed(dataDir, id) || {};
  return {
    chapters: (parsed.chapters || []).map((c) => ({ id: c.id, topic: c.topic || '', title: c.title || '', body: String(c.body || c.markdown || '') })),
    questions: (parsed.questions || []).map(normalizeQuestion),
    glossary: parsed.glossaryFiles || [],
  };
}

function contentHash(dataDir, id) {
  const dir = path.join(store.wbDir(dataDir, id), 'content');
  const h = crypto.createHash('sha256');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== INTERVIEW_CHAPTER_FILE).sort()) {
      h.update(f);
      h.update(fs.readFileSync(path.join(dir, f)));
    }
  }
  return h.digest('hex');
}

function lintMarkup(text, file) {
  return lint.lintWorkbook({ files: [{ name: file, text }] }, { allowMissingTests: true })
    .filter((f) => f.severity === 'error');
}

function chapterFile(dataDir, id) {
  return path.join(store.wbDir(dataDir, id), 'content', INTERVIEW_CHAPTER_FILE);
}

function writeInterviewChapter(dataDir, id, text) {
  const file = chapterFile(dataDir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

function removeInterviewChapter(dataDir, id) {
  fs.rmSync(chapterFile(dataDir, id), { force: true });
}

function readProgress(dataDir, id) { return store.readProgress(dataDir, id) || {}; }
// Compatibility with the plan's progress interface: P1 merges this snapshot,
// ignoring incoming history and replacing latest grades only for newer at values.
function writeProgress(dataDir, id, progress) { store.writeProgress(dataDir, id, progress); }

// Ingestion/practice grade writes use this validated path. Callers supply at
// explicitly (a changed grade needs a newer timestamp); return rejections too.
function recordGrades(dataDir, id, grades) { return store.recordGrades(dataDir, id, grades); }

module.exports = {
  INTERVIEW_CHAPTER_ID, INTERVIEW_CHAPTER_FILE,
  findWorkbook, ensureWorkbook, workbookExists, readWorkbook, contentHash, lintMarkup,
  writeInterviewChapter, removeInterviewChapter, readProgress, writeProgress, recordGrades,
};
