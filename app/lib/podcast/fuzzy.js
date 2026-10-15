// app/lib/podcast/fuzzy.js
// "fuzzy <topic>" (by text or from the app) pulls a recently aired concept back into tomorrow's episode.
const store = require('./store');
const { tokens, jaccard } = require('./master');

function recentConcepts(dataDir, episodes = 7) {
  const seen = new Map();
  for (const ep of store.listEpisodes(dataDir).slice(0, episodes)) {
    for (const c of ep.concepts || []) if (!seen.has(c.id)) seen.set(c.id, { ...c, date: ep.date });
  }
  return [...seen.values()];
}

function fuzzyFromText(dataDir, text) {
  const topic = String(text || '').replace(/^\s*fuzzy\s*(on|about)?\s*/i, '').trim();
  const concepts = recentConcepts(dataDir);
  if (!concepts.length) return { ok: false, message: '🎧 No Daily Drop episodes yet, so nothing to replay.' };
  if (!topic) {
    const list = concepts.slice(0, 6).map((c) => `• ${c.title}`).join('\n');
    return { ok: false, message: `🎧 Which one? Text "fuzzy" plus a few words from the topic:\n${list}` };
  }
  const t = tokens(topic);
  const scored = concepts.map((c) => ({ c, s: jaccard(t, tokens(c.title)) + (String(c.title).toLowerCase().includes(topic.toLowerCase()) ? 1 : 0) }))
    .sort((a, b) => b.s - a.s);
  if (!scored[0] || scored[0].s < 0.15) {
    return { ok: false, message: `🎧 Couldn't match "${topic}". Recent topics:\n${concepts.slice(0, 6).map((c) => `• ${c.title}`).join('\n')}` };
  }
  store.markFuzzy(dataDir, scored[0].c.id);
  return { ok: true, id: scored[0].c.id, message: `🎧 Got it. "${scored[0].c.title}" is back in tomorrow's Daily Drop.` };
}

module.exports = { recentConcepts, fuzzyFromText };
