// app/lib/workbook/lint.js
const { parseTexts, parseChoices, parseTests, referenceSolution } = require('./parse');
const { parseGlossaryText } = require('./glossary');
const { parseDiagram } = require('./diagram');

// The structure every system design chapter follows (the "plain-English standard").
const SD_HEADINGS = [
  'The problem in plain words',
  'Functional requirements',
  'Non-functional requirements',
  'Out of scope',
  'Size estimate',
  'Core entities',
  'API',
  'High-level design',
  'Step by step',
  'Deep dives',
  'Questions they will ask',
];

function diagramBlocks(text) {
  const out = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```diagram\s*$/.test(lines[i])) continue;
    const start = i;
    const body = [];
    i++;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
    out.push({ offset: start, text: body.join('\n'), closed: i < lines.length });
  }
  return out;
}

function sectionOf(body, heading) {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*$`, 'im');
  const m = re.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^##\s/m);
  return next < 0 ? rest : rest.slice(0, next);
}

const TYPES = new Set(['mcq', 'open', 'code']);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const REQUIRED_HEADINGS = [
  ['## In plain English', /^##\s+In plain English\s*$/im],
  ['## Key takeaways', /^##\s+Key takeaways\s*$/im],
];

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function lintWorkbook({ files, glossaryFiles = [] }, opts = {}) {
  const findings = [];
  const add = (file, line, rule, message, severity = 'error') => findings.push({ file, line, rule, message, severity });

  for (const f of [...files, ...glossaryFiles]) {
    String(f.text).replace(/\r/g, '').split('\n').forEach((l, i) => {
      if (/<\/script/i.test(l)) add(f.name, i + 1, 'script-tag', 'content must not contain "</script"');
    });
  }

  const { items, chapters, questions } = parseTexts(files);
  const seen = new Map();
  for (const x of items) {
    const tag = x.kind === 'chapter' ? '@@chapter' : '@@q';
    if (x.company !== undefined && !SLUG.test(x.company)) add(x.file, x.line, 'bad-id', `${tag} company= must be a lowercase alphanumeric slug with optional hyphens, or both`);
    if (!x.id) { add(x.file, x.line, 'missing-id', `${tag} has no id=`); continue; }
    if (!SLUG.test(x.id)) add(x.file, x.line, 'bad-id', `${tag} id= must be a lowercase alphanumeric slug with optional hyphens`);
    if (seen.has(x.id)) add(x.file, x.line, 'dup-id', `id "${x.id}" is already used at ${seen.get(x.id)}`);
    else seen.set(x.id, `${x.file}:${x.line}`);
  }

  const chapterIds = new Set(chapters.map((c) => c.id).filter(Boolean));
  for (const c of chapters) {
    for (const [label, re] of REQUIRED_HEADINGS) {
      if (!re.test(c.body)) add(c.file, c.line, 'chapter-sections', `chapter "${c.id}" is missing the heading "${label}"`);
    }
    if (opts.standard && /^system design$/i.test(String(c.topic || '').trim())) {
      for (const h of SD_HEADINGS) {
        if (sectionOf(c.body, h) === null) add(c.file, c.line, 'sd-structure', `system design chapter "${c.id}" is missing the heading "## ${h}"`);
      }
      const hld = sectionOf(c.body, 'High-level design');
      if (hld !== null && !diagramBlocks(hld).length) add(c.file, c.line, 'sd-structure', `system design chapter "${c.id}" needs a \`\`\`diagram block under "## High-level design"`);
    }
  }

  for (const x of [...chapters, ...questions]) {
    for (const text of [x.body, x.answer]) {
      for (const block of diagramBlocks(text)) {
        if (!block.closed) { add(x.file, x.line, 'diagram', `"${x.id}" has a \`\`\`diagram block that is never closed`); continue; }
        for (const e of parseDiagram(block.text).errors) add(x.file, x.line, 'diagram', `diagram in "${x.id}": ${e}`);
      }
    }
  }

  for (const q of questions) {
    const type = q.attrs.type;
    if (!TYPES.has(type)) add(q.file, q.line, 'q-type', `question "${q.id}" type must be mcq, open, or code`);
    if (!['1', '2', '3'].includes(q.attrs.diff)) add(q.file, q.line, 'q-diff', `question "${q.id}" diff must be 1, 2, or 3`);
    if (!q.attrs.chapter || !chapterIds.has(q.attrs.chapter)) {
      add(q.file, q.line, 'chapter-ref', `question "${q.id}" references unknown chapter "${q.attrs.chapter || ''}"`);
    }
    if (!('answer' in q.sections) || !q.answer) add(q.file, q.line, 'q-answer', `question "${q.id}" has no @@answer`);
    if (type === 'mcq') {
      const ch = parseChoices(q.choices);
      const at = q.sections.choices || q.line;
      if (!('choices' in q.sections) || ch.length < 3) add(q.file, at, 'mcq-choices', `question "${q.id}" needs @@choices with at least 3 options`);
      const nx = ch.filter((c) => c.correct).length;
      if (nx !== 1) add(q.file, at, 'mcq-choices', `question "${q.id}" needs exactly one "- [x]" (found ${nx})`);
      if (ch.length >= 3) {
        const lens = ch.map((c) => [...c.text].length);
        const med = median(lens);
        const max = Math.max(...lens);
        if (max > 1.8 * med) add(q.file, at, 'mcq-balance', `question "${q.id}": longest option is ${max} chars, more than 1.8 × the median (${med})`);
      }
    }
    if (type === 'open' || type === 'code') {
      if (!('rubric' in q.sections) || !q.rubric) add(q.file, q.line, 'rubric', `question "${q.id}" needs a @@rubric`);
    }
    if (type === 'code') {
      const present = 'tests' in q.sections;
      const t = parseTests(present ? q.tests : null);
      if (!t.ok) {
        const severity = !present && opts.allowMissingTests ? 'warning' : 'error';
        const message = present ? `question "${q.id}": ${t.error}` : `question "${q.id}" has no @@tests, so its answer is unverified`;
        add(q.file, q.sections.tests || q.line, 'code-tests', message, severity);
      } else if (!referenceSolution(q.answer, t.value.entry)) {
        add(q.file, q.sections.answer || q.line, 'code-reference', `question "${q.id}": no python block in @@answer defines "${t.value.entry}"`);
      }
    }
  }

  for (const g of glossaryFiles) {
    for (const e of parseGlossaryText(g.text, g.name).errors) add(e.file, e.line, e.rule, e.message);
  }

  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

function errorsOnly(findings) {
  return findings.filter((f) => f.severity === 'error');
}

module.exports = { lintWorkbook, errorsOnly, SD_HEADINGS, diagramBlocks };
