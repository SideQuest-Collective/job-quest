// app/lib/resume/guard.js
const { buildLexicon, matchesAny, termRegex } = require('./lexicon');
const { masterBulletIndex, allMasterText } = require('./master');

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).join('|')})\\b`, 'gi');
const NUM_RE = /\bp\d{2}\b|(?<![A-Za-z0-9.])\$?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?percent|%)?(?:[A-Za-z]+)?\+?(?![0-9])/gi;

function normalizeNumberWords(text) {
  return String(text || '').replace(WORD_RE, (w) => String(WORDS[w.toLowerCase()]));
}

function canonicalNumber(token) {
  let t = token.toLowerCase().replace(/percent/g, '%').replace(/[$,+\s]/g, '');
  t = t.replace(/(?<=\d)(ms|mins?|hrs?|h|s|kb|mb|gb|tb|pb|[kmg]bps|d|w|wks?|mo|yrs?|y|st|nd|rd|th)$/, '').replace(/(?<=\d)bn$/, 'b');
  t = t.replace(/^(\d+)\.(\d*?)0+(?=\D|$)/, (m, a, b) => (b ? `${a}.${b}` : a));
  return t;
}

function numericTokens(text) {
  return [...normalizeNumberWords(text).matchAll(NUM_RE)].map((m) => canonicalNumber(m[0]));
}

// A duration is a compound fact: an unrelated count cannot license tenure,
// and "7 years" and "7+ years" must retain their different claims.
function tenureClaims(text) {
  const re = /(?<![A-Za-z0-9.])(\d+(?:,\d{3})*(?:\.\d+)?)[\s-]*(\+|plus)?[\s-]*(?:years?|yrs?)\b/gi;
  return [...normalizeNumberWords(text).replace(/\b(?:a\s+)?decade\b/gi, '10+ years').matchAll(re)]
    .map((m) => `${canonicalNumber(m[1])}${m[2] ? '+' : ''} year`);
}

const QUANT_RE = /\b(doubled|doubling|tripled|tripling|quadrupled|quadrupling|halved|halving|tenfold|(?:a\s+)?decade|decades|dozens|hundreds|thousands|millions|billions)\b/gi;
const QUANT_EQUIVALENTS = { doubled: '2x', doubling: '2x', tripled: '3x', tripling: '3x', quadrupled: '4x', quadrupling: '4x', halved: '0.5x', halving: '0.5x', tenfold: '10x' };
const TITLE_WORDS = ['Senior Staff', 'Staff', 'Principal', 'Distinguished', 'Lead', 'Engineering Manager', 'Manager', 'Director', 'Head', 'VP', 'Vice President', 'Architect', 'CTO', 'Chief', 'Senior'];
const ROLE_NOUN = '(?:Engineer|Manager|Director|Developer|Architect|Scientist|Officer)';
const ROLE_BEFORE = new RegExp(`\\b${ROLE_NOUN}\\s+$`, 'i');
const ROLE_AFTER = new RegExp(`^\\s+${ROLE_NOUN}\\b`, 'i');

function claimsTitle(text, term, field) {
  return [...text.matchAll(termRegex(term, { flags: 'g' }))].some(match => {
    if (match[0] !== term && match[0] !== term.toUpperCase()) return false;
    // Only ambiguous verbs need summary context; other title words stand alone.
    return field === 'headline'
      || !['Lead', 'Head', 'Architect'].includes(term)
      || ROLE_BEFORE.test(text.slice(0, match.index))
      || ROLE_AFTER.test(text.slice(match.index + match[0].length))
      || (term === 'Head' && /^\s+of\s+[A-Z]/.test(text.slice(match.index + match[0].length)));
  });
}

function supportsDecade(allowedText) {
  return tenureClaims(allowedText).some(c => Number.parseFloat(c) >= 10);
}

function validateTailoredShape(master, t) {
  const v = [];
  const add = (path, detail) => v.push({ path, rule: 'schema', detail });
  if (!t || typeof t !== 'object' || Array.isArray(t)) { add('', 'the tailored resume must be a JSON object'); return v; }
  if (typeof t.headline !== 'string') add('headline', 'must be a string');
  if (typeof t.summary !== 'string' || !t.summary.trim()) add('summary', 'must be non-empty text');
  if (!Array.isArray(t.experience)) add('experience', 'must be an array');
  if (t.projects !== undefined && !Array.isArray(t.projects)) add('projects', 'must be an array');
  if (!Array.isArray(t.skills) || !t.skills.length) add('skills', 'must be a non-empty array');
  else t.skills.forEach((g, i) => { if (!g || typeof g.group !== 'string' || !Array.isArray(g.items) || !g.items.length) add(`skills[${i}]`, 'needs a group name and a non-empty items array'); });
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const shape = (list, path) => {
    if (!Array.isArray(list)) { add(`${path}.bullets`, 'must be an array'); return; }
    list.forEach((b, k) => {
      if (!isObject(b) || typeof b.text !== 'string' || !b.text.trim()) add(`${path}.bullets[${k}].text`, 'must be non-empty text');
    });
  };
  const seenEmployers = new Set();
  const seenRoles = new Set();
  const seenProjects = new Set();
  const unique = (id, seen, path, kind) => {
    if (seen.has(id)) add(`${path}.id`, `duplicate ${kind} id "${id}"`);
    seen.add(id);
  };
  (Array.isArray(t.experience) ? t.experience : []).forEach((te, i) => {
    const path = `experience[${i}]`;
    if (!isObject(te)) { add(path, 'must be an object'); return; }
    unique(te.id, seenEmployers, path, 'employer');
    const me = (master.experience || []).find((e) => e.id === te.id);
    if (!me) add(`${path}.id`, `unknown employer id "${te.id}"`);
    if (!Array.isArray(te.roles)) { add(`${path}.roles`, 'must be an array'); return; }
    te.roles.forEach((tr, j) => {
      const rolePath = `${path}.roles[${j}]`;
      if (!isObject(tr)) { add(rolePath, 'must be an object'); return; }
      unique(tr.id, seenRoles, rolePath, 'role');
      if (!me || !(me.roles || []).some((r) => r.id === tr.id)) add(`${rolePath}.id`, `unknown role id "${tr.id}"`);
      shape(tr.bullets, rolePath);
    });
  });
  (Array.isArray(t.projects) ? t.projects : []).forEach((tp, i) => {
    const path = `projects[${i}]`;
    if (!isObject(tp)) { add(path, 'must be an object'); return; }
    unique(tp.id, seenProjects, path, 'project');
    shape(tp.bullets, path);
  });
  for (const me of master.experience || []) {
    for (const mr of me.roles || []) {
      const te = Array.isArray(t.experience) ? t.experience.find((x) => x && x.id === me.id) : null;
      const tr = te && Array.isArray(te.roles) ? te.roles.find((x) => x && x.id === mr.id) : null;
      if (!tr || !Array.isArray(tr.bullets) || !tr.bullets.length) add(`experience.${me.id}.${mr.id}`, `role "${mr.title}" needs at least one bullet`);
    }
  }
  return v;
}

function checkTailored(master, tailored, { lexicon = buildLexicon(master), keywords = {} } = {}) {
  const violations = [];
  const push = (path, rule, detail) => violations.push({ path, rule, detail });
  violations.push(...validateTailoredShape(master, tailored));
  if (!tailored || typeof tailored !== 'object' || Array.isArray(tailored)) return { pass: false, violations };

  const idx = masterBulletIndex(master);
  const skillsText = (master.skills || []).flatMap((g) => g.items || []).join('\n');
  const union = allMasterText(master);

  const checkNumbers = (text, allowedText, path, rule) => {
    const allowed = new Set(numericTokens(allowedText));
    const allowedTenure = new Set(tenureClaims(allowedText));
    const bad = [...new Set([
      ...numericTokens(text).filter((n) => !allowed.has(n)),
      ...tenureClaims(text).filter((claim) => !allowedTenure.has(claim)
        && !(claim === '10+ year' && /\bdecade\b/i.test(text) && supportsDecade(allowedText))),
      ...[...String(text).matchAll(QUANT_RE)].map(m => m[0].toLowerCase()).filter(word =>
        !termRegex(word).test(allowedText)
        && !(/\bdecade$/.test(word) && supportsDecade(allowedText))
        && !(QUANT_EQUIVALENTS[word] && allowed.has(QUANT_EQUIVALENTS[word]))),
    ])];
    if (bad.length) push(path, rule, `numbers not supported by the source: ${bad.join(', ')}`);
  };
  const checkTools = (text, allowedText, path, rule, keywordAllowedText = allowedText) => {
    const bad = lexicon.find(text).filter((term) => !lexicon.has(term, allowedText));
    // Use the grader's matcher for frozen keywords, including each alternative.
    for (const keyword of [...(keywords.required || []), ...(keywords.preferred || [])]) {
      for (const variant of [keyword.term, ...(keyword.alts || [])]) {
        const term = lexicon.terms.find(t => t.toLowerCase() === String(variant).toLowerCase());
        if (term && matchesAny(text, [variant]) && !lexicon.has(term, keywordAllowedText, { caseSensitive: false })) bad.push(term);
      }
    }
    if (bad.length) push(path, rule, `tools not in the source bullet or master skills: ${[...new Set(bad)].join(', ')}`);
  };
  const checkBullet = (b, path, scope) => {
    if (!b || typeof b !== 'object') return;
    const src = typeof b.src === 'string' ? idx.get(b.src) : undefined;
    if (!src) { push(`${path}.src`, 1, b.src ? `unknown source bullet "${b.src}"` : 'missing src'); return; }
    const inScope = scope.kind === 'exp'
      ? src.kind === 'exp' && src.roleId === scope.roleId
      : src.kind === 'proj' && src.projectId === scope.projectId;
    if (!inScope) push(`${path}.src`, 4, `${b.src} belongs to ${src.label}, not ${scope.label}`);
    const text = typeof b.text === 'string' ? b.text : '';
    checkNumbers(text, src.text, `${path}.text`, 2);
    checkTools(text, `${src.text}\n${skillsText}\n${scope.tech || ''}`, `${path}.text`, 3, `${src.text}\n${skillsText}`);
  };

  (Array.isArray(tailored.experience) ? tailored.experience : []).forEach((te, i) => {
    const me = te && (master.experience || []).find((e) => e.id === te.id);
    if (!me) { push(`experience[${i}]`, 5, `unknown employer id "${te && te.id}"`); return; }
    (Array.isArray(te.roles) ? te.roles : []).forEach((tr, j) => {
      const mr = tr && me.roles.find((r) => r.id === tr.id);
      if (!mr) { push(`experience[${i}].roles[${j}]`, 5, `unknown role id "${tr && tr.id}" at ${me.employer}`); return; }
      (Array.isArray(tr.bullets) ? tr.bullets : []).forEach((b, k) => checkBullet(b, `experience[${i}].roles[${j}].bullets[${k}]`, {
        kind: 'exp', roleId: mr.id, label: `${mr.title} at ${me.employer}`,
      }));
    });
  });
  (Array.isArray(tailored.projects) ? tailored.projects : []).forEach((tp, i) => {
    const mp = tp && (master.projects || []).find((p) => p.id === tp.id);
    if (!mp) { push(`projects[${i}]`, 5, `unknown project id "${tp && tp.id}"`); return; }
    (Array.isArray(tp.bullets) ? tp.bullets : []).forEach((b, k) => checkBullet(b, `projects[${i}].bullets[${k}]`, {
      kind: 'proj', projectId: mp.id, label: mp.name, tech: (mp.tech || []).join('\n'),
    }));
  });

  const skillSet = new Set((master.skills || []).flatMap((g) => g.items || []).map((s) => String(s).trim().toLowerCase()));
  (Array.isArray(tailored.skills) ? tailored.skills : []).forEach((g, i) => {
    (g && Array.isArray(g.items) ? g.items : []).forEach((item, j) => {
      if (!skillSet.has(String(item).trim().toLowerCase())) push(`skills[${i}].items[${j}]`, 6, `"${item}" is not a master skill`);
    });
  });

  for (const field of ['headline', 'summary']) {
    const text = typeof tailored[field] === 'string' ? tailored[field] : '';
    checkNumbers(text, union, field, 7);
    checkTools(text, union, field, 7);
    const unsupportedTitles = TITLE_WORDS.filter(term => claimsTitle(text, term, field)
      // A count of "staff" is not evidence of a Staff-level title.
      && !termRegex(term, { caseSensitive: /Staff/.test(term) }).test(union));
    if (unsupportedTitles.length) push(field, 7, `titles not supported by the master: ${unsupportedTitles.join(', ')}`);
    // Employment assertions have a narrower shape than arbitrary proper nouns.
    // Preserve internal employer abbreviations (U.S.A.), but split Inc.Mentors.
    const employerSpans = (master.experience || []).flatMap(({ employer }) =>
      [...text.matchAll(termRegex(employer.replace(/\.$/, ''), { flags: 'g' }))]
        .map(match => [match.index, match.index + match[0].length]));
    const sentences = text.replace(/[.!?](?:\s+|(?=[A-Z]))/g, (boundary, offset) =>
      boundary.length === 1 && employerSpans.some(([start, end]) => offset >= start && offset + 1 < end)
        ? boundary : '\n').split('\n');
    const employerClaims = sentences.flatMap(sentence =>
      [...sentence.matchAll(/\bat\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)*(?:\s+and\s+[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)*)*)/g)]);
    for (const match of employerClaims) {
      const employers = match[1].replace(/\.$/, '').split(/\s+and\s+/);
      const bad = employers.filter(name => !termRegex(name).test(union));
      if (bad.length) push(field, 7, `employers not supported by the master: ${bad.join(', ')}`);
    }
  }
  return { pass: violations.length === 0, violations };
}

module.exports = { normalizeNumberWords, numericTokens, validateTailoredShape, checkTailored };
