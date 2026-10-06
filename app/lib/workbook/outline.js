// app/lib/workbook/outline.js
const KINDS = ['company', 'coding', 'system-design', 'behavioral', 'concepts'];
const TYPES = ['mcq', 'open', 'code'];
const BUDGETS = {
  screen: { chapters: [5, 7], questions: [25, 35], requireKinds: ['company', 'coding', 'system-design', 'behavioral'], minTypePct: 20 },
  onsite: { chapters: [4, 8], questions: [25, 45], requireKinds: [], minTypePct: 0 },
};
const FIXED_TOPICS = { 'system-design': 'System design', behavioral: 'Behavioral' };
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_QUESTIONS_PER_CHAPTER = 10;

function validateOutline(outline, { tier, existingIds = [] }) {
  const b = BUDGETS[tier];
  if (!b) return [`unknown tier "${tier}"`];
  if (!outline || typeof outline !== 'object' || !Array.isArray(outline.chapters)) return ['"chapters" must be an array'];
  const errors = [];
  const ids = new Set();
  const existing = new Set(existingIds);
  const typeCounts = { mcq: 0, open: 0, code: 0 };
  const kinds = new Set();
  let total = 0;
  outline.chapters.forEach((c, i) => {
    const where = `chapters[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} must be an object`); return; }
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) errors.push(`${where}.id must be 2-41 lowercase letters, digits, or dashes`);
    else if (ids.has(c.id)) errors.push(`${where}.id "${c.id}" is repeated`);
    else if (existing.has(c.id)) errors.push(`${where}.id "${c.id}" already exists in the workbook`);
    else ids.add(c.id);
    for (const k of ['title', 'topic', 'summary']) {
      if (typeof c[k] !== 'string' || !c[k].trim()) errors.push(`${where}.${k} must be a non-empty string`);
    }
    for (const k of ['title', 'topic']) {
      if (typeof c[k] === 'string' && /["\n]/.test(c[k])) errors.push(`${where}.${k} must not contain double quotes or newlines`);
    }
    if (typeof c.company !== 'string' || !(c.company === 'both' || SLUG_RE.test(c.company))) errors.push(`${where}.company must be the company slug or "both"`);
    if (!KINDS.includes(c.kind)) errors.push(`${where}.kind must be one of ${KINDS.join(', ')}`);
    else {
      kinds.add(c.kind);
      if (FIXED_TOPICS[c.kind] && c.topic !== FIXED_TOPICS[c.kind]) errors.push(`${where}.topic must be "${FIXED_TOPICS[c.kind]}" for kind ${c.kind}`);
    }
    if (!Array.isArray(c.questions) || c.questions.length > MAX_QUESTIONS_PER_CHAPTER) {
      errors.push(`${where}.questions must be an array of at most ${MAX_QUESTIONS_PER_CHAPTER}`);
      return;
    }
    c.questions.forEach((q, j) => {
      const qw = `${where}.questions[${j}]`;
      if (!q || !TYPES.includes(q.type)) errors.push(`${qw}.type must be mcq, open, or code`);
      else typeCounts[q.type] += 1;
      if (!q || ![1, 2, 3].includes(q.diff)) errors.push(`${qw}.diff must be 1, 2, or 3`);
      if (!q || typeof q.focus !== 'string' || !q.focus.trim()) errors.push(`${qw}.focus must be a non-empty string`);
    });
    total += c.questions.length;
  });
  const n = outline.chapters.length;
  if (n < b.chapters[0] || n > b.chapters[1]) errors.push(`expected ${b.chapters[0]}-${b.chapters[1]} chapters, got ${n}`);
  if (total < b.questions[0] || total > b.questions[1]) errors.push(`expected ${b.questions[0]}-${b.questions[1]} questions in total, got ${total}`);
  for (const k of b.requireKinds) if (!kinds.has(k)) errors.push(`needs at least one chapter of kind "${k}"`);
  if (b.minTypePct && total) {
    const need = Math.ceil((total * b.minTypePct) / 100);
    for (const t of TYPES) {
      if (typeCounts[t] < need) errors.push(`needs at least ${need} ${t} questions (${b.minTypePct}% of ${total}), got ${typeCounts[t]}`);
    }
  }
  return errors;
}

function assignIds(outline, { startIndex = 0, runId = null } = {}) {
  return {
    chapters: outline.chapters.map((c, i) => {
      const nn = String(startIndex + i + 1).padStart(2, '0');
      return {
        id: c.id, title: c.title.trim(), topic: c.topic.trim(), company: c.company, kind: c.kind, summary: c.summary.trim(),
        nn, file: `${nn}-${c.id}.md`, glossaryFile: `glossary-${nn}.txt`, addedBy: runId,
        questions: c.questions.map((q, j) => ({ id: `${c.id}-q${j + 1}`, type: q.type, diff: q.diff, focus: q.focus.trim() })),
      };
    }),
  };
}

function headerLines(ch) {
  return [
    `@@chapter id=${ch.id} company=${ch.company} topic="${ch.topic}" title="${ch.title}"`,
    ...ch.questions.map((q) => `@@q id=${q.id} company=${ch.company} topic="${ch.topic}" type=${q.type} diff=${q.diff} chapter=${ch.id}`),
  ];
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function extractJsonObject(text) {
  const s = String(text || '').trim();
  try { return asObject(JSON.parse(s)); } catch {}
  const fence = s.match(/```(?:json)?[^\n]*\n([\s\S]*?)```/);
  if (fence) { try { return asObject(JSON.parse(fence[1])); } catch {} }
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return asObject(JSON.parse(s.slice(start, i + 1))); } catch { return null; }
      }
    }
  }
  return null;
}

module.exports = { KINDS, TYPES, BUDGETS, FIXED_TOPICS, validateOutline, assignIds, headerLines, extractJsonObject };
