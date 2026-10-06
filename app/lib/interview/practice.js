// app/lib/interview/practice.js
// Deterministic practice set for practice/<roleId>.json (contract: inbound files).
const { CONTRACT, GENERATED_BY } = require('./contract');

const norm = (s) => String(s || '').trim().toLowerCase();

function roundFilter(round) {
  switch (round) {
    case 'coding': return (q) => q.type === 'code' || /coding|algorithm|data structure/.test(norm(q.topic));
    case 'system': return (q) => norm(q.topic) === 'system design';
    case 'behavioral': return (q) => norm(q.topic) === 'behavioral';
    case 'screen': return (q) => norm(q.topic) !== 'behavioral';
    default: return null;
  }
}

function gradeRank(progress, qid) {
  const g = progress && progress.grades && progress.grades[qid] && progress.grades[qid].grade;
  if (g === 'missed') return 0;
  if (g === 'partial') return 1;
  if (g === 'got') return 3;
  return 2;
}

function buildPracticeSet({ roleKey, workbookId, round, questions, progress = {}, limit = 20 }) {
  const keep = roundFilter(round);
  if (!keep) return null;
  if (!Number.isInteger(limit) || limit <= 0) limit = 20;
  const picked = questions
    .filter((q) => keep(q) && String(q.prompt || '').trim() && q.id)
    .sort((a, b) => gradeRank(progress, a.id) - gradeRank(progress, b.id)
      || (Number(a.diff) || 2) - (Number(b.diff) || 2)
      || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .slice(0, limit);
  return {
    _generatedBy: GENERATED_BY,
    contract: CONTRACT,
    roleKey,
    workbookId,
    round,
    questions: picked.map((q) => ({
      qid: q.id, prompt: q.prompt || '', type: q.type, rubric: q.rubric || '', answer: q.answer || '',
      choices: Array.isArray(q.choices) ? q.choices.slice() : [],
    })),
  };
}

module.exports = { roundFilter, buildPracticeSet };
