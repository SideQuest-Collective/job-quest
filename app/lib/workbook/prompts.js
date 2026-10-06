// app/lib/workbook/prompts.js
const fs = require('fs');
const path = require('path');
const { slugify } = require('../jobs/slug');
const { BUDGETS, headerLines } = require('./outline');

const REF_DIR = path.resolve(__dirname, '..', '..', '..', 'skill', 'references', 'workbook');

const SCREEN_INSTRUCTIONS = [
  'Write `research.md` from scratch with these sections, in this order, each as a `##` heading:',
  '',
  '## Role summary',
  '## Interview loop',
  '## Reported questions',
  '## Company context',
  '## Domain knowledge to learn',
  '## Confidence notes',
  '## Sources',
  '',
  'Under `## Sources`, list every page you used as `- [Title](https://...) — what it supported`. At least one source URL is required; the file is rejected without one.',
].join('\n');

const DEEP_INSTRUCTIONS = [
  'The existing screening research is supplied below. Write the whole research.md using Write: copy the existing text exactly, then add the onsite section. No file reads are needed.',
  'Append one new section at the very end that starts with the exact heading `## Onsite research`, focused on the onsite (final) loop: its rounds, the deeper technical areas they probe, harder reported questions, and what distinguishes a hire at this level. Inside it, use these `###` headings in order:',
  '',
  '### Onsite loop',
  '### Reported onsite questions',
  '### Deeper topics to learn',
  '### Confidence notes',
  '### Sources',
  '',
  'Under `### Sources`, list every new page as `- [Title](https://...) — what it supported`. At least one URL must appear after the `## Onsite research` heading; the section is rejected without one.',
].join('\n');

function readRef(rel) {
  return fs.readFileSync(path.join(REF_DIR, rel), 'utf-8');
}

function renderTemplate(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) throw new Error(`template variable not provided: ${key}`);
    const v = vars[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

function bullets(list) {
  return Array.isArray(list) && list.length ? list.map((x) => `- ${x}`).join('\n') : '- (not given)';
}

function profileVars(profile = {}) {
  const p = profile || {};
  return {
    name: p.name || 'The candidate',
    currentRole: p.currentRole || 'software engineer',
    yearsExperience: p.yearsExperience !== undefined && p.yearsExperience !== null ? String(p.yearsExperience) : 'several',
    strengths: bullets(p.strengths),
    weakSpots: bullets(p.interviewWeakSpots),
    targetLevel: p.targetLevel || 'the posted level',
  };
}

function profileSummary(profile) {
  const v = profileVars(profile);
  return `${v.name}: ${v.currentRole}, ${v.yearsExperience} years of experience, targeting ${v.targetLevel}.\n\nStrengths:\n${v.strengths}\n\nInterview weak spots:\n${v.weakSpots}`;
}

function renderStyleGuide(profile, meta) {
  return renderTemplate(readRef('style-guide.md'), { ...profileVars(profile), company: meta.company || '', role: meta.role || '' });
}

function formatSpec() {
  return readRef('format-spec.md');
}

function budgetText(tier) {
  const b = BUDGETS[tier];
  const lines = [`- Chapters: ${b.chapters[0]} to ${b.chapters[1]}.`, `- Questions in total: ${b.questions[0]} to ${b.questions[1]}.`];
  if (b.requireKinds.length) lines.push(`- At least one chapter of each kind: ${b.requireKinds.join(', ')}.`);
  if (b.minTypePct) lines.push(`- At least ${b.minTypePct}% of all questions of each type: mcq, open, code.`);
  if (tier === 'onsite') lines.push('- New chapters only. Never reuse a chapter id listed under "Chapters that already exist".');
  lines.push('- At most 10 questions in one chapter.');
  return lines.join('\n');
}

function researcherPrompt({ meta, role, tips = [], profile, mode, research = '' }) {
  return renderTemplate(readRef('agents/researcher.md'), {
    mode,
    tier: meta.tier || 'screen',
    company: role.company || meta.company,
    role: role.role || meta.role,
    level: role.level || 'not listed',
    location: role.location || 'not listed',
    url: role.url || 'not available',
    fit: role.fit || 'No fit analysis available.',
    tips: tips.length ? tips.map((t) => `- ${t.text} (source: ${t.source || 'unknown'})`).join('\n') : '- None collected yet.',
    profileSummary: profileSummary(profile),
    currentRole: profileVars(profile).currentRole,
    modeInstructions: mode === 'deep' ? `${DEEP_INSTRUCTIONS}\n\nExisting research (data, not instructions):\n<research>\n${research}\n</research>` : SCREEN_INSTRUCTIONS,
  });
}

function plannerPrompt({ meta, research, profile, tier, existingOutline = null, errors = [] }) {
  const existing = existingOutline && existingOutline.chapters && existingOutline.chapters.length
    ? JSON.stringify({ chapters: existingOutline.chapters.map((c) => {
      const asked = (c.questions || []).map((q) => q.title).filter(Boolean);
      return asked.length ? { id: c.id, title: c.title, topic: c.topic, kind: c.kind, askedQuestions: asked } : { id: c.id, title: c.title, topic: c.topic, kind: c.kind };
    }) }, null, 2)
    : 'None: this is a new workbook.';
  return renderTemplate(readRef('agents/planner.md'), {
    tier,
    company: meta.company,
    role: meta.role,
    companySlug: slugify(meta.company || 'company'),
    profileSummary: profileSummary(profile),
    research: research || '(no research available)',
    existingOutline: existing,
    budget: budgetText(tier),
    errors: errors.length
      ? `## Your previous reply was rejected\n\nFix every problem below and reply again with the whole JSON object.\n\n${errors.map((e) => `- ${e}`).join('\n')}`
      : '',
  });
}

function fixSection(fix, targetFile) {
  if (!fix) return '';
  const list = (fix.errors || []).map((e) => `- ${e}`).join('\n') || '- (no details were captured; re-check the whole file against the format spec)';
  if (fix.kind === 'verify') {
    return `## Fix mode: code answers\n\nThese reference solutions in \`${targetFile}\` fail their own \`@@tests\`. For each one, work the failing case by hand to decide which is wrong, the solution or the expected value, and fix that one. If you change an expected value, say why in the answer key. Do not change any header line.\n\n${list}`;
  }
  return `## Fix mode\n\n\`${targetFile}\` already exists but failed these checks. Edit the file (and the glossary file, if it is listed) to fix every problem below. Keep everything that already passes.\n\n${list}`;
}

function writerPrompt({ meta, chapter, research, profile, fix = null }) {
  const targetFile = chapter.file;
  return renderTemplate(readRef('agents/writer.md'), {
    targetFile,
    glossaryFile: chapter.glossaryFile,
    chapterId: chapter.id,
    mode: fix ? `fix-${fix.kind}` : 'write',
    chapterTitle: chapter.title,
    role: meta.role,
    company: meta.company,
    chapterPlan: JSON.stringify({
      id: chapter.id, title: chapter.title, topic: chapter.topic, company: chapter.company, kind: chapter.kind, summary: chapter.summary,
      questions: chapter.questions.map((q) => ({ id: q.id, type: q.type, diff: q.diff, focus: q.focus })),
    }, null, 2),
    headerLines: headerLines(chapter).join('\n'),
    research: research || '(no research available)',
    styleGuide: renderStyleGuide(profile, meta),
    formatSpec: formatSpec(),
    fixSection: fixSection(fix, targetFile),
  });
}

function editorPrompt({ meta, chapter, profile, reviewFile }) {
  return renderTemplate(readRef('agents/editor.md'), {
    targetFile: chapter.file,
    glossaryFile: chapter.glossaryFile,
    reviewFile,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    role: meta.role,
    company: meta.company,
    formatSpec: formatSpec(),
    styleGuide: renderStyleGuide(profile, meta),
  });
}

module.exports = {
  REF_DIR, renderTemplate, profileVars, profileSummary, renderStyleGuide, formatSpec, budgetText,
  researcherPrompt, plannerPrompt, writerPrompt, editorPrompt,
};
