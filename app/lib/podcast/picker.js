// app/lib/podcast/picker.js
// Code, not the agent, decides what today's episode covers:
//   - weak spots from recent real-interview debriefs (what actually wobbled),
//   - master cheat-sheet cards (urgent roles first, flagged "fuzzy" ones forced in, recently aired ones held back),
//   - one spaced-repetition question that is due, used as the "pause and answer" quiz.
const fs = require('fs');
const path = require('path');
const { readJson, readHistory, shortHash } = require('./store');

const DAY = 86400000;

function daysBetween(a, b) { return Math.floor((new Date(b) - new Date(a)) / DAY); }

function recentWeakSpots(dataDir, today, { windowDays = 21 } = {}) {
  const dir = path.join(dataDir, 'interview-work', 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const folder of fs.readdirSync(dir).sort().reverse()) {
    const m = folder.match(/^(\d{4}-\d{2}-\d{2})_\d{4}(?:_(.+))?$/);
    if (!m || daysBetween(m[1], today) > windowDays) continue;
    const a = readJson(path.join(dir, folder, 'analysis.json'), null);
    if (!a || !Array.isArray(a.weakSpots)) continue;
    const asked = Array.isArray(a.asked) ? a.asked : [];
    for (const w of a.weakSpots) {
      if (!w || !w.label) continue;
      const q = typeof w.ref === 'number' ? asked[w.ref] : null;
      out.push({
        id: shortHash(`weak|${folder}|${w.label}`),
        kind: 'weak-spot',
        date: m[1],
        session: (m[2] || '').replace(/-/g, ' '),
        label: String(w.label),
        question: q ? { title: q.title, rubric: String(q.rubric || '').slice(0, 900) } : null,
      });
    }
  }
  return out;
}

function dueReviewQuestions(dataDir, now, readWorkbook) {
  const srs = readJson(path.join(dataDir, 'trainer', 'workbook-srs.json'), {});
  const due = Object.entries(srs)
    .filter(([, v]) => v && !v.retired && v.dueAt && new Date(v.dueAt) <= now)
    .sort((a, b) => new Date(a[1].dueAt) - new Date(b[1].dueAt));
  const out = [];
  const cache = new Map();
  for (const [key] of due) {
    const [wbId, qId] = key.split(':');
    if (!cache.has(wbId)) { try { cache.set(wbId, readWorkbook(dataDir, wbId)); } catch { cache.set(wbId, null); } }
    const wb = cache.get(wbId);
    const q = wb && wb.questions.find((x) => x.id === qId);
    if (!q || !q.prompt) continue;
    out.push({ id: shortHash(`srs|${key}`), kind: 'review', srsKey: key, workbookId: wbId, prompt: q.prompt.slice(0, 1200), answer: (q.answer || q.rubric).slice(0, 1200), topic: q.topic });
    if (out.length >= 3) break;
  }
  return out;
}

function pickConcepts({ dataDir, master, today, now = new Date(), readWorkbook, counts = { weak: 2, cards: 3, review: 1 } }) {
  const history = readHistory(dataDir);
  const aired = (id) => history[id] && history[id].lastAired;
  const freshness = (id) => {
    const h = history[id];
    if (!h) return 8; // never aired
    if (h.fuzzy) return 20; // he asked for it again
    const d = daysBetween(h.lastAired, today);
    return d < 3 ? -100 : Math.min(d, 10) - h.airCount; // hold back for 3 days, then return on a widening schedule
  };

  const weak = recentWeakSpots(dataDir, today)
    .map((w) => ({ ...w, score: freshness(w.id) + (w.date ? 10 - Math.min(10, daysBetween(w.date, today)) : 0) }))
    .filter((w) => w.score > -50)
    .sort((a, b) => b.score - a.score)
    .slice(0, counts.weak);

  const cards = [];
  const seenCompanies = new Map();
  const ranked = (master.cards || [])
    .map((c) => ({ ...c, score: c.priority + freshness(c.id) * 4 }))
    .filter((c) => c.score > -50)
    .sort((a, b) => b.score - a.score);
  for (const c of ranked) {
    // Spread across companies: at most two cards whose lead company repeats.
    const lead = c.companies[0];
    if ((seenCompanies.get(lead) || 0) >= 2 && !c.shared) continue;
    seenCompanies.set(lead, (seenCompanies.get(lead) || 0) + 1);
    cards.push({ id: c.id, kind: 'card', title: c.title, category: c.category, bullets: c.bullets, code: c.code, companies: c.companies, shared: c.shared });
    if (cards.length >= counts.cards) break;
  }
  // Few companies with sheets yet: fill the remaining slots from the top of the ranking.
  for (const c of ranked) {
    if (cards.length >= counts.cards) break;
    if (cards.some((x) => x.id === c.id)) continue;
    cards.push({ id: c.id, kind: 'card', title: c.title, category: c.category, bullets: c.bullets, code: c.code, companies: c.companies, shared: c.shared });
  }

  const review = readWorkbook ? dueReviewQuestions(dataDir, now, readWorkbook).filter((q) => !aired(q.id) || freshness(q.id) > -50).slice(0, counts.review) : [];
  return { weak, cards, review, all: [...weak, ...cards, ...review] };
}

module.exports = { recentWeakSpots, dueReviewQuestions, pickConcepts };
