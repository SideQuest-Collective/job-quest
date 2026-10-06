// app/tests/workbook-prompts.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../lib/workbook/prompts');
const { assignIds, headerLines } = require('../lib/workbook/outline');
const { screenOutline } = require('./helpers/workbook-outlines');

const meta = { id: 'acme-staff-engineer', company: 'Acme', role: 'Staff Engineer', tier: 'screen', companyNames: { acme: 'Acme' } };
const profile = { name: 'Sam', currentRole: 'Senior Engineer', yearsExperience: 7, strengths: ['React', 'APIs'], interviewWeakSpots: ['system design', 'algorithms'], targetLevel: 'Staff' };
const role = { company: 'Acme', role: 'Staff Engineer', level: 'Staff', location: 'NYC', url: 'https://jobs.example/acme/1', fit: 'Strong backend fit.' };
const chapter = assignIds(screenOutline()).chapters[1];

const noPlaceholders = (s) => assert.doesNotMatch(s, /\{\{\w+\}\}/);

test('renderTemplate fills values once and throws on missing ones', () => {
  assert.equal(prompts.renderTemplate('a {{x}} b {{y}}', { x: '{{y}}', y: 2 }), 'a {{y}} b 2');
  assert.throws(() => prompts.renderTemplate('{{nope}}', {}), /template variable not provided: nope/);
});

test('style guide is personalised from the profile', () => {
  const s = prompts.renderStyleGuide(profile, meta);
  noPlaceholders(s);
  assert.match(s, /Sam: Senior Engineer, about 7 years/);
  assert.match(s, /- system design\n- algorithms/);
  assert.match(s, /the Staff Engineer role at Acme/);
  assert.match(prompts.renderStyleGuide({}, meta), /The candidate: software engineer/);
});

test('format spec documents every directive', () => {
  const f = prompts.formatSpec();
  for (const needle of ['@@chapter', '@@q', '@@choices', '@@hint', '@@rubric', '@@tests', '@@answer', '## In plain English', '## Key takeaways', '1.8', '</script']) {
    assert.ok(f.includes(needle), needle);
  }
});

test('researcher prompt: screen and deep modes', () => {
  const screen = prompts.researcherPrompt({ meta, role, tips: [{ text: 'They love numbers.', source: 'Blind' }], profile, mode: 'screen' });
  noPlaceholders(screen);
  assert.match(screen, /^MODE: screen$/m);
  assert.match(screen, /https:\/\/jobs\.example\/acme\/1/);
  assert.match(screen, /They love numbers\. \(source: Blind\)/);
  assert.match(screen, /## Sources/);
  const deep = prompts.researcherPrompt({ meta, role, tips: [], profile, mode: 'deep' });
  assert.match(deep, /^MODE: deep$/m);
  assert.match(deep, /## Onsite research/);
});

test('planner prompt carries tier, budget, existing chapters, and retry errors', () => {
  const p = prompts.plannerPrompt({ meta, research: 'R', profile, tier: 'onsite', existingOutline: { chapters: [{ id: 'arrays', title: 'Arrays', topic: 'Coding', kind: 'coding' }] }, errors: ['expected 4-8 chapters, got 2'] });
  noPlaceholders(p);
  assert.match(p, /^TIER: onsite$/m);
  assert.match(p, /- Chapters: 4 to 8\./);
  assert.match(p, /"id": "arrays"/);
  const withAsked = prompts.plannerPrompt({ meta, research: 'R', profile, tier: 'screen', existingOutline: { chapters: [{ id: 'asked-in-interviews', title: 'Asked in your interviews', topic: 'Interviews', kind: 'concepts', questions: [{ id: 'iv-1', title: 'How would you rate-limit an API?' }] }] }, errors: [] });
  assert.match(withAsked, /"askedQuestions": \[\s*"How would you rate-limit an API\?"/);
  assert.match(p, /Your previous reply was rejected[\s\S]*expected 4-8 chapters, got 2/);
  const fresh = prompts.plannerPrompt({ meta, research: 'R', profile, tier: 'screen', existingOutline: null, errors: [] });
  assert.match(fresh, /None: this is a new workbook\./);
  assert.match(fresh, /"company":"acme"/);
  assert.doesNotMatch(fresh, /previous reply was rejected/);
});

test('writer prompt has machine lines, exact headers, and fix sections', () => {
  const w = prompts.writerPrompt({ meta, chapter, research: 'R', profile, fix: null });
  noPlaceholders(w);
  assert.match(w, /^TARGET_FILE: 02-arrays\.md$/m);
  assert.match(w, /^GLOSSARY_FILE: glossary-02\.txt$/m);
  assert.match(w, /^CHAPTER_ID: arrays$/m);
  assert.match(w, /^MODE: write$/m);
  const block = w.split('HEADERS-BEGIN\n')[1].split('\nHEADERS-END')[0];
  assert.equal(block, headerLines(chapter).join('\n'));
  const lint = prompts.writerPrompt({ meta, chapter, research: 'R', profile, fix: { kind: 'lint', errors: ['02-arrays.md:3 [rubric] missing'] } });
  assert.match(lint, /^MODE: fix-lint$/m);
  assert.match(lint, /- 02-arrays\.md:3 \[rubric\] missing/);
  const ver = prompts.writerPrompt({ meta, chapter, research: 'R', profile, fix: { kind: 'verify', errors: ['arrays-q1: case 0: expected 2, got 3'] } });
  assert.match(ver, /^MODE: fix-verify$/m);
  assert.match(ver, /fail their own `@@tests`/);
});

test('editor prompt names the review file', () => {
  const e = prompts.editorPrompt({ meta, chapter, profile, reviewFile: '.review/arrays.json' });
  noPlaceholders(e);
  assert.match(e, /^TARGET_FILE: 02-arrays\.md$/m);
  assert.match(e, /^REVIEW_FILE: \.review\/arrays\.json$/m);
  assert.match(e, /"chapterId":"arrays"/);
});
