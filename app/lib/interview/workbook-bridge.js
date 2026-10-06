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
const { writeFileAtomic } = require('./atomic');

const INTERVIEW_CHAPTER_ID = CHAPTER_ID;
const INTERVIEW_CHAPTER_FILE = '99-asked-in-interviews.md';

function findWorkbook(dataDir, roleKey) {
  const meta = store.findByRoleKey(dataDir, roleKey);
  return meta ? { id: meta.id, dir: store.wbDir(dataDir, meta.id), meta } : null;
}

function ensureWorkbook(dataDir, { roleKey, company, role }) {
  const found = findWorkbook(dataDir, roleKey);
  if (found) return { ...found, created: false };
  const meta = store.createMinimalWorkbook(dataDir, { roleKey, company, role, title: `${company}: ${role}` });
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
    chapters: (parsed.chapters || []).map((c) => ({ id: c.id, topic: c.topic || '', title: c.title || '', body: String(c.body || '') })),
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
  if (!workbookExists(dataDir, id)) throw new Error(`workbook ${id} not found`);
  const file = chapterFile(dataDir, id);
  writeFileAtomic(file, text);
  return file;
}

function removeInterviewChapter(dataDir, id) {
  fs.rmSync(chapterFile(dataDir, id), { force: true });
}

function readProgress(dataDir, id) { return store.readProgress(dataDir, id); }

// Ingestion/practice grade writes use this validated path. Callers supply at
// explicitly (a changed grade needs a newer timestamp); return rejections too.
function recordGrades(dataDir, id, grades) { return store.recordGrades(dataDir, id, grades); }

module.exports = {
  INTERVIEW_CHAPTER_ID, INTERVIEW_CHAPTER_FILE,
  findWorkbook, ensureWorkbook, workbookExists, readWorkbook, contentHash, lintMarkup,
  writeInterviewChapter, removeInterviewChapter, readProgress, recordGrades,
};
