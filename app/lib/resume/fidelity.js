// app/lib/resume/fidelity.js
// How far a tailored resume strays from the master. The tailor may angle the headline
// focus and the summary's first and last sentence, reorder bullets, and swap up to 2;
// everything else should read as the master does.
const { eligibleMaster, masterBulletIndex, allMasterText } = require('./master');

const F_MAX = 30;
const BASE_PROJECTS = 2;
const FREE_SWAPS = 2;
// Share of words that may differ before a bullet counts as rewritten.
const REWRITE_RATIO = 0.15;
const SHINGLE = 4;
const PENALTY = { dropped: 5, rewritten: 3, jdPhrase: 3, headline: 5, summary: 5, swap: 3 };
const STOP = new Set('a an and are as at be by for from has have in into is it its of on or our that the their this to we will with you your who whose which across over'.split(' '));

const round1 = (x) => Math.round(x * 10) / 10;
const words = (text) => String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// A digit that is not a year: "(2026)" alone does not make a bullet quantified.
const isQuantified = (text) => /\d/.test(String(text || '').replace(/\b(?:19|20)\d{2}\b/g, ''));

function summarySentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).filter(Boolean);
}

// The summary sentences the tailor must copy: all but the first and the last.
const summaryCore = (summary) => summarySentences(summary).slice(1, -1);

const headlineTitle = (headline) => String(headline || '').split('|')[0].trim();

// The resume the tailor starts from, sized to fill about one page: the quantified
// experience bullets in master order, and the first bullet of the first two eligible
// projects. Every other eligible bullet or project is an optional add-in. `keep` lists
// the quantified experience bullets, which must all appear.
function baseSelection(master) {
  const m = eligibleMaster(master);
  const roles = [];
  for (const e of m.experience || []) {
    for (const r of e.roles || []) {
      const keep = r.bullets.filter((b) => isQuantified(b.text)).map((b) => b.id);
      roles.push({ id: r.id, title: r.title, bullets: keep, keep, optional: r.bullets.map((b) => b.id).filter((id) => !keep.includes(id)) });
    }
  }
  const eligibleProjects = m.projects || [];
  const projects = eligibleProjects.slice(0, BASE_PROJECTS).map((p) => ({ id: p.id, name: p.name, bullets: [p.bullets[0].id] }));
  return {
    roles,
    projects,
    optionalProjects: eligibleProjects.slice(BASE_PROJECTS).map((p) => ({ id: p.id, name: p.name })),
    keep: roles.flatMap((r) => r.keep),
    ids: new Set([...roles.flatMap((r) => r.bullets), ...projects.flatMap((p) => p.bullets)]),
  };
}

// The base selection as the tailor prompt shows it.
function describeBase(master) {
  const base = baseSelection(master);
  const core = summaryCore(master.summary);
  const title = String(master.headline || '').includes('|') ? headlineTitle(master.headline) : '';
  return [
    'Experience: every bullet below, in this order. [keep] marks a quantified impact bullet that must appear.',
    ...base.roles.map((r) => `- Role \`${r.id}\` (${r.title}): ${r.bullets.map((id) => (r.keep.includes(id) ? `${id} [keep]` : id)).join(', ') || 'none'}`),
    `Projects: ${base.projects.length ? base.projects.map((p) => `${p.bullets[0]} (${p.name})`).join(', ') : 'none'}`,
    'Optional add-ins (at most 2 in total, only when they fit this job better and the page has room):',
    ...base.roles.filter((r) => r.optional.length).map((r) => `- Role \`${r.id}\`: ${r.optional.join(', ')}`),
    `- Projects: ${base.optionalProjects.length ? base.optionalProjects.map((p) => `${p.id} (${p.name})`).join(', ') : 'none'}, or another bullet of a base project`,
    `Headline title to keep before the |: ${title ? `"${title}"` : 'none (write a short focus line)'}`,
    core.length ? 'Summary sentences to copy word for word, in this order:' : 'Summary: the master summary has no middle sentences to copy.',
    ...core.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
}

function wordEditRatio(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length);
}

// A phrase never runs across a |, so "Title | Focus" is two runs of words.
const segments = (text) => String(text || '').split('|');

function shingles(text) {
  const out = new Set();
  for (const seg of segments(text)) {
    const w = words(seg);
    for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(' '));
  }
  return out;
}

// Runs of 4+ words copied from the job description that the allowed text does not already contain.
function jdPhrases(text, jdSet, allowed) {
  return segments(text).flatMap((seg) => segmentPhrases(seg, jdSet, allowed));
}

function segmentPhrases(text, jdSet, allowed) {
  const w = words(text);
  const spans = [];
  for (let i = 0; i + SHINGLE <= w.length; i++) {
    const g = w.slice(i, i + SHINGLE);
    const key = g.join(' ');
    if (!jdSet.has(key) || allowed.has(key) || g.filter((t) => !STOP.has(t)).length < 2) continue;
    const last = spans[spans.length - 1];
    if (last && i <= last.end) last.end = i + SHINGLE;
    else spans.push({ start: i, end: i + SHINGLE });
  }
  return spans.map((s) => w.slice(s.start, s.end).join(' '));
}

function tailoredBullets(t) {
  const out = [];
  const take = (bullets) => { for (const b of Array.isArray(bullets) ? bullets : []) if (b && typeof b.src === 'string') out.push({ src: b.src, text: String(b.text || '') }); };
  for (const e of Array.isArray(t.experience) ? t.experience : []) for (const r of (e && Array.isArray(e.roles) ? e.roles : [])) take(r && r.bullets);
  for (const p of Array.isArray(t.projects) ? t.projects : []) take(p && p.bullets);
  return out;
}

function checkFidelity({ master, tailored, jd = '', keywords = {} }) {
  const checks = [];
  const add = (id, pass, detail = '') => checks.push({ cat: 'F', id, pass: !!pass, detail });
  const t = tailored && typeof tailored === 'object' ? tailored : {};
  const base = baseSelection(master);
  const idx = masterBulletIndex(master);
  const used = tailoredBullets(t);
  const usedIds = new Set(used.map((b) => b.src));

  const dropped = base.keep.filter((id) => !usedIds.has(id));
  add('quantified-kept', !dropped.length, dropped.length ? `left out: ${dropped.join(', ')}` : '');

  const rewritten = used.filter((b) => idx.has(b.src))
    .map((b) => ({ src: b.src, changed: Math.round(wordEditRatio(b.text, idx.get(b.src).text) * 100) / 100 }))
    .filter((r) => r.changed > REWRITE_RATIO);
  add('bullets-verbatim', !rewritten.length, rewritten.map((r) => `${r.src} (${Math.round(r.changed * 100)}% of words changed)`).join(', '));

  const jdSet = shingles(jd);
  const masterSet = shingles(allMasterText(eligibleMaster(master)));
  const phrases = [];
  for (const b of used) {
    const found = jdPhrases(b.text, jdSet, shingles(idx.has(b.src) ? idx.get(b.src).text : ''));
    if (found.length) phrases.push({ where: b.src, phrases: found });
  }
  for (const field of ['headline', 'summary']) {
    const found = jdPhrases(t[field], jdSet, masterSet);
    if (found.length) phrases.push({ where: field, phrases: found });
  }
  add('no-jd-phrases', !phrases.length, phrases.map((p) => `${p.where}: "${p.phrases.join('", "')}"`).join('; '));

  const headline = String(t.headline || '');
  const title = String(master.headline || '').includes('|') ? headlineTitle(master.headline) : '';
  const target = String(keywords.title || '').trim();
  const titleKept = !title || norm(headlineTitle(headline)) === norm(title);
  const retitled = !!target && norm(headline).includes(norm(target)) && !norm(master.headline).includes(norm(target));
  add('headline-title', titleKept && !retitled, !titleKept ? `the headline should start with "${title}"` : retitled ? `the headline uses the job title "${target}"` : '');

  const core = summaryCore(master.summary);
  const summary = norm(t.summary);
  const coreMissing = core.filter((s) => !summary.includes(norm(s)));
  const sentences = summarySentences(t.summary).length;
  const summaryKept = !coreMissing.length && sentences <= core.length + 2;
  add('summary-core', summaryKept, coreMissing.length ? `master sentences missing or changed: ${coreMissing.map((s) => `"${s.slice(0, 40)}..."`).join(', ')}`
    : summaryKept ? '' : `${sentences} sentences; write only a new first and last sentence around the master's ${core.length}`);

  const swaps = used.map((b) => b.src).filter((id) => !base.ids.has(id));
  add('swaps', swaps.length <= FREE_SWAPS, `${swaps.length} bullet(s) outside the base${swaps.length ? `: ${swaps.join(', ')}` : ''}`);

  const F = F_MAX
    - PENALTY.dropped * dropped.length
    - PENALTY.rewritten * rewritten.length
    - PENALTY.jdPhrase * phrases.length
    - (titleKept && !retitled ? 0 : PENALTY.headline)
    - (summaryKept ? 0 : PENALTY.summary)
    - PENALTY.swap * Math.max(0, swaps.length - FREE_SWAPS);
  return { F: round1(Math.max(0, F)), checks, fidelity: { dropped, rewritten, jdPhrases: phrases, swaps } };
}

module.exports = {
  F_MAX, FREE_SWAPS, REWRITE_RATIO, PENALTY, isQuantified, summarySentences, summaryCore, headlineTitle,
  baseSelection, describeBase, wordEditRatio, jdPhrases, shingles, checkFidelity,
};
