// Read-only suggestions from actual unfinished work and reviewed answers.
// These do not reschedule tasks, mark completion, or infer mastery.
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const crypto = require('crypto');
const workbook = require('../workbook/store');
const hashing = { id:'builtin:hashing', title:'Hash-table retrieval', content:'A hash table maps a key to a bucket using a hash function. Collisions occur when different keys map to the same bucket; chaining or probing resolves them. Expected lookup can be O(1) under suitable hashing and load, but worst-case lookup can be O(n). Sorting is useful when ordered iteration or range queries matter.' };
const practiceCheck = {
  id: 'builtin:practice-check', title: 'Practice planning and retrieval',
  content: 'State the inputs and expected output, clarify constraints, work through a small example, and explain how you would check the result. For a design or behavioral answer, state the goal, assumptions, a concrete example, and a trade-off. A short reflection is preparation, not proof that the full exercise is solved.',
};
const compact = (value, max = 900) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function validReview(a) {
  return a && a.status === 'done' && !a.superseded && compact(a.answer) && Number.isFinite(a.evaluation?.score) &&
    a.evaluation.score >= 0 && a.evaluation.score <= 10 && a.evaluation.maxScore === 10 && Array.isArray(a.evaluation.improvements);
}
function readReviews(dataDir, warnings) {
  const dir = path.join(dataDir, 'feedback');
  if (!fs.existsSync(dir)) return [];
  try {
    const attempts = fs.readdirSync(dir).filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    // A later reviewed answer replaces an older suggestion for that question.
    const latest = new Map();
    for (const a of attempts.filter(validReview).sort((a, b) => String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)))) {
      const key = `${a.source || a.kind}:${a.kind}:${a.questionId}`;
      if (!latest.has(key)) latest.set(key, a);
    }
    return [...latest.values()].filter(a => compact(a.evaluation.nextRep) && a.evaluation.improvements.some(v => compact(v)));
  } catch { warnings.push('Reviewed practice could not be read. Suggestions below still use your unfinished work.'); return []; }
}
function matchesMedia(m, choice) {
  // Broad native categories such as arrays-hashing are not concept evidence.
  if (m.id === 'media:mit-hashing') return (choice.tags || []).some(t => ['hash-map', 'hash-set', 'hashing', 'hash-table'].includes(t)) || /\b(hash(?:ing| table| map| set)|collision)\b/i.test(choice.title);
  if (m.id === 'media:aws-resilience') return /\b(resilien\w*|availability zones?|fault toleran\w*|failover|disaster recovery)\b/i.test(`${choice.title} ${(choice.tags || []).join(' ')}`);
  return false;
}
function recommendations(dataDir, { choices = [], state, linkedSources = [] }) {
  const warnings = [];
  const references = [practiceCheck, ...state.sources.filter(s => s.kind === 'concept'), ...linkedSources];
  const lookup = id => references.find(s => s.id === id);
  const feedback = [];
  for (const a of readReviews(dataDir, warnings)) {
    const session = state.sessions.find(s => s.id === a.id && s.status === 'answered' && s.response === a.answer);
    let reference, context;
    if (a.source === 'learning') {
      if (!session) continue;
      reference = session.kind === 'media' ? practiceCheck : lookup(session.sourceId);
      // Built-in hashing remains a supported reference in the UI.
      if (!reference && session.sourceId === 'builtin:hashing') reference = {id: 'builtin:hashing', title: 'Hash-table retrieval'};
      if (!reference) continue;
      context = session.planContext || null;
    } else if (['behavioral', 'trainer'].includes(a.source)) {
      reference = practiceCheck;
      context = { choiceId: `feedback:${a.id}`, title: compact(a.context?.question, 200) || 'Reviewed answer', href: a.source === 'trainer' ? '/#trainer' : '/#behavioral' };
    } else if (a.source === 'workbook') {
      const {workbookId, questionId} = a.assistance || {};
      if (!workbook.isValidId(workbookId) || typeof questionId !== 'string' || !workbook.readMeta(dataDir, workbookId)) continue;
      const key = 'wb_' + crypto.createHash('sha256').update(JSON.stringify([workbookId, questionId])).digest('hex');
      if (a.questionId !== key) continue;
      const q = workbook.loadParsed(dataDir, workbookId).questions.find(q => q.id === questionId);
      if (!q || q.body !== a.context?.question) continue;
      reference = practiceCheck;
      context = { choiceId:`workbook:${workbookId}:${questionId}`, title:compact(q.title || q.topic, 200) || 'Reviewed workbook question', href:`/workbooks/${encodeURIComponent(workbookId)}#question/${encodeURIComponent(questionId)}` };
    } else continue; // No inferred identity for other stores.
    const nextRep = compact(a.evaluation.nextRep);
    feedback.push({ id: `feedback:${a.id}`, title: 'Practice a reviewed gap', reason: `From your reviewed answer: ${compact(a.evaluation.improvements.find(v => compact(v)), 240)}`,
      goal: compact(session?.goal) || compact(context?.title) || reference.title, prompt: `Next rep from your coach: ${nextRep}\n\nPrevious question for context: ${compact(session?.prompt || a.context?.question, 700)}`,
      reference, planContext: { ...(context || {choiceId: `feedback:${a.id}`, title: compact(session?.goal) || reference.title}), feedbackAttemptId: a.id }, feedbackAttemptId: a.id });
  }
  const byMinutes = {};
  for (const minutes of [5, 15, 30]) {
    const reps = feedback.slice(0, 2).map(r => ({ ...r, minutes, kind: 'retrieval' }));
    for (const c of choices.slice(0, 4)) {
      const planContext = { choiceId: c.id, title: c.title, href: c.href, reason: c.reason, ...(c.planId ? {planId: c.planId} : {}) };
      const concept = lookup(c.conceptId || c.sourceId) || (matchesMedia({id:'media:mit-hashing'}, c) ? hashing : null);
      const prompt = `Your next practice goal is “${compact(c.title, 250)}”. Before starting, name one question you need to clarify, one small example you would use to check your understanding, and a stopping point for the next session. Open the full practice task whenever you need its statement. This is an optional planning rep; it does not test whether you can solve the full problem.`;
      reps.push({ id: `${minutes}:${c.id}`, title: minutes === 5 ? (concept ? `Recall ${concept.title} for ${c.title}` : `Optional planning rep: ${c.title}`) : c.title, reason: c.reason, minutes,
        kind: minutes === 5 ? 'retrieval' : 'native', href: c.href, goal: `Prepare for ${compact(c.title, 250)}`,
        prompt: minutes === 5 && concept ? `Without revealing the reference, explain “${concept.title}” from memory. Give one concrete example and one limitation or trade-off. Then open “${compact(c.title,250)}” to decide whether the concept applies. This recalls the concept; it does not demonstrate solving the full task.` : prompt,
        reference: concept || practiceCheck, conceptRecall:minutes === 5 && !!concept, planContext, suggestedMinutes: c.minutes });
    }
    byMinutes[minutes] = reps.slice(0, 5);
  }
  const media = catalog.map(m => {
    const target = choices.find(c => matchesMedia(m, c));
    const followUp = target ? {choiceId: target.id, title: target.title, href: target.href, reason: target.reason, ...(target.planId ? {planId: target.planId} : {})} :
      {choiceId: m.id, title: m.id === 'media:mit-hashing' ? 'Apply hashing in Code Lab' : 'Practice a resilient system design', href: m.id === 'media:mit-hashing' ? '/#codelab' : '/#sysdesign', reason: 'Optional concept practice; no matching unfinished task found'};
    return { ...m, matched: !!target, planContext: followUp, goal: target ? `${m.goal} Apply it to ${compact(target.title, 250)}.` : m.goal,
      reflection: `${m.reflection}\nThen ${target ? `apply one idea to “${compact(target.title, 250)}” and name a trade-off before continuing the full exercise.` : 'describe a small application of this concept, then choose an exercise in the linked practice tool.'}` };
  }).sort((a, b) => Number(b.matched) - Number(a.matched));
  return { recommendations: byMinutes, media, recommendationWarnings: warnings };
}
module.exports = { recommendations, practiceCheck, hashing, matchesMedia, validReview };
