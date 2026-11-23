// app/lib/workbook/progress.js
const { isDeepStrictEqual } = require('node:util');
const GRADES = new Set(['got', 'partial', 'missed']);
const WEIGHTS = { 1: 1, 2: 2, 3: 3 };

function emptyProgress() {
  return { version: 1, revision: 0, answers: {}, grades: {}, history: {}, notes: {}, lastChapter: null, ui: {} };
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function normalizeProgress(p) {
  const src = obj(p);
  const history = {};
  for (const [qid, list] of Object.entries(obj(src.history))) {
    if (Array.isArray(list)) history[qid] = list.filter((h) => h && GRADES.has(h.grade) && typeof h.at === 'string').map((h) => ({ ...h }));
  }
  return {
    version: 1,
    revision: Number.isSafeInteger(src.revision) && src.revision >= 0 ? src.revision : 0,
    answers: { ...obj(src.answers) },
    grades: { ...obj(src.grades) },
    history,
    notes: { ...obj(src.notes) },
    lastChapter: typeof src.lastChapter === 'string' ? src.lastChapter : null,
    ui: { ...obj(src.ui) },
  };
}

function validGrade(g) {
  return g && GRADES.has(g.grade) && typeof g.at === 'string' && !Number.isNaN(Date.parse(g.at));
}

function mergeProgress(existing, incoming) {
  const before = normalizeProgress(existing);
  const out = normalizeProgress(existing);
  const inc = obj(incoming);
  if (inc.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(inc.expectedRevision) || inc.expectedRevision < 0) throw Object.assign(new Error('Workbook revision must be a nonnegative integer.'), {status:400});
    if (inc.expectedRevision !== out.revision) throw Object.assign(new Error('This workbook changed on another device. Your browser draft is preserved; choose which answers to keep.'), {status:409, current:out});
  }
  for (const [qid, text] of Object.entries(obj(inc.answers))) if (typeof text === 'string') out.answers[qid] = text;
  for (const [qid, text] of Object.entries(obj(inc.notes))) if (typeof text === 'string') out.notes[qid] = text;
  for (const [qid, g] of Object.entries(obj(inc.grades))) {
    if (!validGrade(g)) continue;
    const entry = { grade: g.grade, at: new Date(g.at).toISOString(), source: typeof g.source === 'string' && g.source ? g.source : 'dashboard' };
    const hist = out.history[qid] || (out.history[qid] = []);
    if (!hist.some((h) => h.at === entry.at && h.grade === entry.grade)) {
      hist.push(entry);
      hist.sort((a, b) => a.at.localeCompare(b.at));
    }
    const cur = out.grades[qid];
    if (!cur || !validGrade(cur) || Date.parse(entry.at) > Date.parse(cur.at)) out.grades[qid] = entry;
  }
  if (typeof inc.lastChapter === 'string') out.lastChapter = inc.lastChapter;
  if (inc.ui && typeof inc.ui === 'object' && !Array.isArray(inc.ui)) {
    const priorPicks = obj(out.ui.picks);
    out.ui = { ...out.ui, ...inc.ui };
    if (Object.keys(priorPicks).length || Object.hasOwn(inc.ui, 'picks')) {
      const picks = {};
      for (const qid of new Set([...Object.keys(priorPicks), ...Object.keys(obj(inc.ui.picks))])) {
        const prior = obj(priorPicks[qid]), next = obj(obj(inc.ui.picks)[qid]);
        picks[qid] = { ...prior, ...next };
        for (const key of ['assisted', 'revealed', 'hintUsed']) if (prior[key] === true || next[key] === true) picks[qid][key] = true;
      }
      out.ui.picks = picks;
    }
  }
  // Replaying a recorded grade or saving unchanged text is a true no-op.
  // New answers, history or help evidence still invalidate stale browser drafts.
  if (!isDeepStrictEqual(out, before)) out.revision++;
  return out;
}

function weight(q) {
  return WEIGHTS[q.diff] || 2;
}

function readiness(questions, progress) {
  const p = normalizeProgress(progress);
  let total = 0;
  let got = 0;
  for (const q of questions) {
    const w = weight(q);
    total += w;
    const g = p.grades[q.id];
    if (g && g.grade === 'got') got += w;
    else if (g && g.grade === 'partial') got += 0.5 * w;
  }
  return total ? Math.round((100 * got) / total) : 0;
}

function misses(questions, progress) {
  const p = normalizeProgress(progress);
  const ids = new Set(questions.map((q) => q.id));
  return Object.entries(p.grades)
    .filter(([qid, g]) => ids.has(qid) && validGrade(g) && (g.grade === 'partial' || g.grade === 'missed'))
    .map(([qid, g]) => ({ qid, grade: g.grade, at: new Date(g.at).toISOString() }))
    .sort((a, b) => a.at.localeCompare(b.at) || (a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0));
}

function summarize(questions, progress) {
  const p = normalizeProgress(progress);
  return {
    readiness: readiness(questions, p),
    graded: questions.filter((q) => p.grades[q.id]).length,
    total: questions.length,
    misses: misses(questions, p).length,
  };
}

module.exports = { GRADES, emptyProgress, normalizeProgress, mergeProgress, weight, readiness, misses, summarize };
