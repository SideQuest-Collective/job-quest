// app/lib/workbook/trainer.js
const path = require('path');
const store = require('./store');
const { parseChoices } = require('./parse');
const { srsFromHistory } = require('./srs');

const OPEN = new Set(['pending', 'in-progress']);
const TARGETABLE = new Set(['pending', 'in-progress', 'answered']);
const LETTERS = 'ABCDEFGHIJ';

function questionsFile(dataDir) { return path.join(dataDir, 'trainer', 'questions.json'); }
function loadQuestions(dataDir) {
  const v = store.readJsonFile(questionsFile(dataDir), []);
  return Array.isArray(v) ? v : [];
}
function saveQuestions(dataDir, qs) { store.writeJsonAtomic(questionsFile(dataDir), qs); }

function buildReviewQueue(dataDir) {
  const all = {};
  for (const meta of store.listWorkbooks(dataDir)) {
    const ids = new Set(store.loadParsed(dataDir, meta.id).questions.map((q) => q.id));
    const progress = store.readProgress(dataDir, meta.id);
    for (const [qid, hist] of Object.entries(progress.history)) {
      if (!ids.has(qid)) continue;
      const st = srsFromHistory(hist);
      if (st) all[`${meta.id}:${qid}`] = st;
    }
  }
  return all;
}
function writeSrsSnapshot(dataDir, srs) { store.writeJsonAtomic(path.join(dataDir, 'trainer', 'workbook-srs.json'), srs); }

// Same deterministic shuffle as the viewer (app/public/workbook.html), so letters match what the learner saw.
function shuffleChoices(id, list) {
  const ch = list.slice();
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  for (let i = ch.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    const j = h % (i + 1);
    const t = ch[i]; ch[i] = ch[j]; ch[j] = t;
  }
  return ch;
}
function orderedChoices(q) {
  return shuffleChoices(q.id, parseChoices(q.choices)).map((c, i) => ({ letter: LETTERS[i], text: c.text, correct: c.correct }));
}
function categoryFor(q) {
  if (/^system design$/i.test(q.topic || '')) return 'system-design';
  if (/^behavioral$/i.test(q.topic || '')) return 'behavioral';
  if (q.type === 'code') return 'coding';
  return 'technical';
}
function firstParagraph(md, max = 600) {
  const p = String(md || '').replace(/\r/g, '').split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('```')) || '';
  return p.length > max ? `${p.slice(0, max - 1)}…` : p;
}

function pickWorkbookQuestion(dataDir, { now = () => new Date() } = {}) {
  const questions = loadQuestions(dataDir);
  if (questions.slice(-2).some((q) => q && q.source === 'workbook')) return { picked: false, reason: 'recent-workbook-question' };
  const open = new Set(questions.filter((q) => q && q.source === 'workbook' && OPEN.has(q.status)).map((q) => `${q.workbookId}:${q.qid}`));
  const srs = buildReviewQueue(dataDir);
  writeSrsSnapshot(dataDir, srs);
  const t = now().getTime();
  const due = Object.entries(srs)
    .filter(([key, s]) => !s.retired && s.dueAt && Date.parse(s.dueAt) <= t && !open.has(key))
    .sort((a, b) => a[1].dueAt.localeCompare(b[1].dueAt) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [key] of due) {
    const i = key.indexOf(':');
    const wbId = key.slice(0, i);
    const qid = key.slice(i + 1);
    const meta = store.readMeta(dataDir, wbId);
    const q = meta && store.loadParsed(dataDir, wbId).questions.find((x) => x.id === qid);
    if (!q) continue;
    const choices = q.type === 'mcq' ? orderedChoices(q) : [];
    const prompt = q.body.trim();
    const choiceText = choices.length ? `\n\n${choices.map((c) => `${c.letter}) ${c.text}`).join('\n')}` : '';
    const baseId = `tq_${Math.floor(t / 1000)}`;
    const usedIds = new Set(questions.filter(Boolean).map((x) => x.id));
    let id = baseId;
    for (let suffix = 1; usedIds.has(id); suffix++) {
      id = `${baseId}_wb${suffix === 1 ? '' : `_${suffix}`}`;
    }
    const record = {
      id, askedAt: new Date(t).toISOString(), roleKey: (meta.roleKeys || [])[0] || '', company: meta.company || '', role: meta.role || '',
      category: categoryFor(q), question: `${prompt}${choiceText}`, whatTheyLookFor: q.rubric || '',
      status: 'pending', answer: null, evaluation: null, answeredAt: null,
      source: 'workbook', workbookId: wbId, workbookTitle: meta.title, qid, qtype: q.type,
      rubric: q.rubric || '', answerKey: q.answer || '', choices,
    };
    questions.push(record);
    saveQuestions(dataDir, questions);
    const how = q.type === 'mcq' ? 'Reply with the letter' : 'Reply here with your answer';
    const message = `🎯 Interview Trainer — ${meta.title} (workbook review)\n\n${prompt}${choiceText}\n\n${how} ('skip' to pass, 'next' for a new question), or use http://localhost:3847 → Trainer`;
    return { picked: true, id, record, message, summary: `${meta.title} | ${qid}` };
  }
  return { picked: false, reason: 'nothing-due' };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/^[\s"'“”‘’.,;:!?()-]+|[\s"'“”‘’.,;:!?()-]+$/g, '');
}

function gradeMcqReply(choices, reply) {
  const r = String(reply || '').trim();
  if (!r) return -1;
  const m = r.match(/^\(?([A-Za-z])\)?[.):]?$/) || r.match(/^\(?([A-Za-z])[).:]\s+\S/);
  if (m) {
    const i = LETTERS.indexOf(m[1].toUpperCase());
    return i >= 0 && i < choices.length ? i : -1;
  }
  const n = norm(r);
  return choices.findIndex((c) => norm(c.text) === n);
}

function findTarget(questions) {
  for (let i = questions.length - 1; i >= 0; i--) {
    const q = questions[i];
    if (q && TARGETABLE.has(q.status)) return q;
  }
  return null;
}

function handleMcqReply(dataDir, reply, { now = () => new Date() } = {}) {
  const questions = loadQuestions(dataDir);
  const target = findTarget(questions);
  if (!target || target.source !== 'workbook' || target.qtype !== 'mcq' || !store.readMeta(dataDir, target.workbookId)) return { handled: false };
  if (target.status === 'answered') return { handled: true, text: "❓ That workbook question is already graded. Text 'next' for a new one." };
  const choices = target.choices || [];
  const idx = gradeMcqReply(choices, reply);
  if (idx < 0) return { handled: true, text: `❓ Reply with a letter from A to ${LETTERS[Math.max(choices.length - 1, 0)]}, or the exact option text.` };
  const correct = choices.findIndex((c) => c.correct);
  const grade = idx === correct ? 'got' : 'missed';
  const at = new Date(now()).toISOString();
  store.writeGrades(dataDir, target.workbookId, [{ qid: target.qid, grade, at, source: 'trainer' }]);
  const evaluation = { score: grade === 'got' ? 10 : 0, maxScore: 10, strengths: [], improvements: [], feedback: firstParagraph(target.answerKey), grade };
  Object.assign(target, { status: 'answered', answer: String(reply).trim(), answeredAt: at, evaluation, initialEvaluation: evaluation, finalEvaluation: evaluation, workbookGradeRecorded: true });
  saveQuestions(dataDir, questions);
  writeSrsSnapshot(dataDir, buildReviewQueue(dataDir));
  const right = choices[correct] || { letter: '?', text: '' };
  const head = grade === 'got'
    ? `🏁 Correct (${choices[idx].letter}) 🟢 — ${target.workbookTitle || target.company}`
    : `🏁 Not quite 🔴 — the answer is ${right.letter}) ${right.text}`;
  return { handled: true, grade, text: evaluation.feedback ? `${head}\n\n${evaluation.feedback}` : head };
}

function recordTrainerGrade(dataDir, id, { now = () => new Date() } = {}) {
  const questions = loadQuestions(dataDir);
  const target = questions.find((q) => q && q.id === id);
  if (!target || target.source !== 'workbook') return { recorded: false, reason: 'not-a-workbook-question' };
  if (target.workbookGradeRecorded) return { recorded: false, reason: 'already-recorded' };
  const grade = target.initialEvaluation && target.initialEvaluation.grade;
  if (!['got', 'partial', 'missed'].includes(grade)) return { recorded: false, reason: 'no-grade' };
  if (!store.readMeta(dataDir, target.workbookId)) return { recorded: false, reason: 'workbook-missing' };
  store.writeGrades(dataDir, target.workbookId, [{ qid: target.qid, grade, at: new Date(now()).toISOString(), source: 'trainer' }]);
  target.workbookGradeRecorded = true;
  saveQuestions(dataDir, questions);
  writeSrsSnapshot(dataDir, buildReviewQueue(dataDir));
  return { recorded: true, grade };
}

module.exports = { buildReviewQueue, pickWorkbookQuestion, gradeMcqReply, handleMcqReply, recordTrainerGrade, shuffleChoices };
