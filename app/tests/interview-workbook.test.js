// app/tests/interview-workbook.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const markup = require('../lib/interview/workbook-markup');
const bridge = require('../lib/interview/workbook-bridge');
const resume = require('../lib/interview/resume-bridge');
const { makeEnv, ROLE_KEY, seedWorkbook } = require('./helpers/interview-env');

const ITEM = {
  title: 'Rate limiter: sliding window', prompt: 'Accept at most three requests in a ten-second sliding window.', type: 'open',
  topic: 'Coding', diff: 2, rubric: 'Evict expired timestamps before checking the limit.', answer: 'Keep a queue of accepted timestamps and remove those outside the active window.',
  grade: 'partial', evidence: 'needed a hint',
};
const AT = '2026-03-14T14:30:00.000Z';
const ROLE = { roleKey: ROLE_KEY, company: 'Acme Capital', role: 'Software Engineer' };

test('qidFor uses the folder digits and a 1-based index', () => {
  assert.equal(markup.qidFor('2026-03-14_0930', 1), 'iv-202603140930-1');
  assert.equal(markup.qidFor('2026-03-14_0930', 12), 'iv-202603140930-12');
});

test('renderQuestion escapes markup tokens and </script', () => {
  const evil = { ...ITEM, prompt: 'Line one\n@@answer\nsneaky', answer: 'use <script>x</script> carefully' };
  const text = markup.renderQuestion(evil, { qid: 'iv-1-1', companySlug: 'acme', date: '2026-03-14', round: 'coding' });
  assert.ok(text.startsWith('@@q id=iv-1-1 company=acme topic="Coding" type=open diff=2 chapter=asked-in-interviews\n'));
  assert.ok(text.includes('\n\\@@answer\nsneaky'));
  assert.equal(text.match(/^@@answer$/gm).length, 1);
  assert.ok(!/<\/script/i.test(text));
  assert.ok(text.includes('<\\/script>'));
});

test('renderChapter has the required sections, a session list, and grade counts', () => {
  const text = markup.renderChapter({
    companySlug: 'acme-capital',
    sessions: [{ date: '2026-03-14', round: 'coding', interviewer: 'Alex', durationMin: 45, count: 1 }],
    questions: [{ qid: 'iv-202603140930-1', item: ITEM, date: '2026-03-14', round: 'coding' }],
  });
  assert.ok(text.startsWith('@@chapter id=asked-in-interviews company=acme-capital topic="Interviews" title="Asked in your interviews"\n'));
  assert.ok(text.includes('## In plain English'));
  assert.ok(text.includes('## Key takeaways'));
  assert.ok(text.includes('- 2026-03-14: Coding round with Alex, 45 min (1 question)'));
  assert.ok(text.includes('- 0 missed, 1 partial, 0 got across 1 question.'));
  assert.ok(text.includes('@@q id=iv-202603140930-1 '));
});

test('mergeGrades appends, replaces the same at+source, and keeps the newest as latest', () => {
  let p = markup.mergeGrades({}, [{ qid: 'q1', grade: 'missed', at: AT, source: 'interview' }]);
  assert.deepEqual(p.grades.q1, { grade: 'missed', at: AT, source: 'interview' });
  p = markup.mergeGrades(p, [{ qid: 'q1', grade: 'partial', at: AT, source: 'interview' }]);
  assert.equal(p.history.q1.length, 1);
  assert.equal(p.grades.q1.grade, 'partial');
  p.history.q1.push({ grade: 'got', at: '2026-10-01T00:00:00.000Z', source: 'dashboard' });
  p = markup.mergeGrades(p, [{ qid: 'q1', grade: 'missed', at: AT, source: 'interview' }]);
  assert.equal(p.history.q1.length, 2);
  assert.deepEqual(p.grades.q1, { grade: 'got', at: '2026-10-01T00:00:00.000Z', source: 'dashboard' });
});

test('mergeGrades does not mutate its input', () => {
  const before = { version: 1, grades: {}, history: {} };
  markup.mergeGrades(before, [{ qid: 'q1', grade: 'got', at: AT, source: 'interview' }]);
  assert.deepEqual(before, { version: 1, grades: {}, history: {} });
});

test('ensureWorkbook creates once with source interview; findWorkbook finds it', () => {
  const { dataDir } = makeEnv();
  assert.equal(bridge.findWorkbook(dataDir, ROLE_KEY), null);
  const a = bridge.ensureWorkbook(dataDir, ROLE);
  assert.equal(a.created, true);
  assert.equal(a.meta.source, 'interview');
  assert.deepEqual(a.meta.roleKeys, [ROLE_KEY]);
  const b = bridge.ensureWorkbook(dataDir, ROLE);
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  assert.equal(bridge.findWorkbook(dataDir, ROLE_KEY).id, a.id);
  assert.equal(bridge.workbookExists(dataDir, a.id), true);
  assert.equal(bridge.workbookExists(dataDir, 'nope'), false);
});

test('an interview chapter written by the bridge parses and lints clean through P1', () => {
  const { dataDir } = makeEnv();
  const wb = bridge.ensureWorkbook(dataDir, ROLE);
  const text = markup.renderChapter({
    companySlug: 'acme-capital',
    sessions: [{ date: '2026-03-14', round: 'coding', interviewer: 'Alex', durationMin: 45, count: 2 }],
    questions: [
      { qid: markup.qidFor('2026-03-14_0930', 1), item: { ...ITEM, prompt: 'Has a line\n@@answer\ninside' }, date: '2026-03-14', round: 'coding' },
      { qid: markup.qidFor('2026-03-14_0930', 2), item: { ...ITEM, type: 'code', title: 'Code it' }, date: '2026-03-14', round: 'coding' },
    ],
  });
  assert.deepEqual(bridge.lintMarkup(text, 'check.md'), []);
  bridge.writeInterviewChapter(dataDir, wb.id, text);
  const content = bridge.readWorkbook(dataDir, wb.id);
  const qs = content.questions.filter((q) => q.chapter === 'asked-in-interviews');
  assert.deepEqual(qs.map((q) => q.id), ['iv-202603140930-1', 'iv-202603140930-2']);
  assert.equal(qs[0].answer, ITEM.answer);
  assert.ok(content.chapters.some((c) => c.id === 'asked-in-interviews'));
});

test('lintMarkup still reports a question without @@answer', () => {
  const bad = '@@chapter id=x company=a topic="T" title="T"\n## In plain English\nx\n## Key takeaways\n- y\n\n'
    + '@@q id=q1 company=a topic="T" type=open diff=1 chapter=x\nPrompt\n@@rubric\nr\n';
  assert.ok(bridge.lintMarkup(bad, 'bad.md').length > 0);
});

test('contentHash ignores the interview chapter and tracks generated content', () => {
  const { dataDir } = makeEnv();
  const wb = seedWorkbook(dataDir);
  const h1 = bridge.contentHash(dataDir, wb.id);
  bridge.writeInterviewChapter(dataDir, wb.id, 'anything');
  assert.equal(bridge.contentHash(dataDir, wb.id), h1);
  fs.appendFileSync(path.join(wb.dir, 'content', '01-coding-basics.md'), '\n');
  assert.notEqual(bridge.contentHash(dataDir, wb.id), h1);
  bridge.removeInterviewChapter(dataDir, wb.id);
  assert.equal(fs.existsSync(path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE)), false);
  assert.equal(fs.existsSync(path.join(wb.dir, 'content', '01-coding-basics.md')), true);
});

test('readWorkbook normalizes P1 questions', () => {
  const { dataDir } = makeEnv();
  const wb = seedWorkbook(dataDir);
  const { questions } = bridge.readWorkbook(dataDir, wb.id);
  assert.deepEqual(questions.map((q) => [q.id, q.type, q.topic, q.diff]), [
    ['c1', 'code', 'Coding', 2], ['s1', 'open', 'System design', 3], ['b1', 'open', 'Behavioral', 1],
  ]);
  assert.match(questions[1].answer, /token bucket/i);
});

test('progress round-trips through the bridge', () => {
  const { dataDir } = makeEnv();
  const wb = bridge.ensureWorkbook(dataDir, ROLE);
  const p = markup.mergeGrades(bridge.readProgress(dataDir, wb.id), [{ qid: 'q1', grade: 'missed', at: AT, source: 'interview' }]);
  bridge.writeProgress(dataDir, wb.id, p);
  assert.equal(bridge.readProgress(dataDir, wb.id).grades.q1.source, 'interview');
});

test('findTailored reads meta.json and jd.txt by the resume spec layout', () => {
  const { dataDir } = makeEnv();
  assert.equal(resume.findTailored(dataDir, ROLE_KEY), null);
  const dir = path.join(dataDir, 'resume', 'tailored', 'acme-capital-software-engineer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'acme-capital-software-engineer', roleKeys: [ROLE_KEY], status: 'done' }));
  fs.writeFileSync(path.join(dir, 'jd.txt'), 'Build trading tools.');
  const t = resume.findTailored(dataDir, ROLE_KEY);
  assert.equal(t.jdText, 'Build trading tools.');
  assert.equal(t.done, true);
});

test('fetchJdText normalizes string, object, failure, and throw', async () => {
  assert.deepEqual(await resume.fetchJdText('u', async () => 'JD text'), { ok: true, text: 'JD text' });
  assert.deepEqual(await resume.fetchJdText('u', async () => ({ ok: true, text: 'JD' })), { ok: true, text: 'JD' });
  assert.deepEqual(await resume.fetchJdText('u', async () => ({ ok: false, error: 'posting unavailable' })), { ok: false, error: 'posting unavailable' });
  assert.deepEqual(await resume.fetchJdText('u', async () => { throw new Error('ENOTFOUND'); }), { ok: false, error: 'ENOTFOUND' });
});

test('readMasterResume returns null when there is no master', () => {
  const { dataDir } = makeEnv();
  assert.equal(resume.readMasterResume(dataDir), null);
});

test('readMasterResume throws with the path when master.json is corrupt', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(dataDir, 'resume', 'master.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ invalid JSON');
  assert.throws(() => resume.readMasterResume(dataDir), (err) => {
    assert.match(err.message, /master\.json/);
    assert.ok(err.message.includes(file));
    return true;
  });
});

test('recordGrades preserves caller timestamps and only a newer grade replaces latest', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wb = seedWorkbook(dataDir);
  const first = { qid: 'c1', grade: 'missed', at: AT, source: 'interview' };
  assert.deepEqual(bridge.recordGrades(dataDir, wb.id, [first]).recorded, ['c1']);
  bridge.recordGrades(dataDir, wb.id, [first]);
  assert.equal(bridge.readProgress(dataDir, wb.id).history.c1.length, 1);

  bridge.recordGrades(dataDir, wb.id, [{ ...first, grade: 'got' }]);
  assert.equal(bridge.readProgress(dataDir, wb.id).grades.c1.grade, 'missed');
  const later = '2026-10-06T12:00:00.000Z';
  const result = bridge.recordGrades(dataDir, wb.id, [{ ...first, grade: 'got', at: later }]);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.progress.grades.c1, { grade: 'got', at: later, source: 'interview' });
  assert.deepEqual(bridge.readProgress(dataDir, wb.id).grades.c1, result.progress.grades.c1);
});

test('recordGrades surfaces rejected entries and still records valid grades', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wb = seedWorkbook(dataDir);
  const first = { qid: 'c1', grade: 'got', at: AT, source: 'interview-practice' };
  const result = bridge.recordGrades(dataDir, wb.id, [
    first,
    { ...first, qid: 'ghost' },
    { ...first, qid: 's1', grade: 'meh' },
    { qid: 'b1', grade: 'partial', source: 'interview' },
  ]);
  assert.deepEqual(result.recorded, ['c1']);
  assert.deepEqual(result.rejected, [
    { qid: 'ghost', reason: 'question does not exist in this workbook' },
    { qid: 's1', reason: 'grade must be got, partial, or missed' },
    { qid: 'b1', reason: 'at must be a parseable timestamp' },
  ]);
  assert.deepEqual(result.progress.grades, { c1: { grade: 'got', at: AT, source: 'interview-practice' } });
});

test('readWorkbook maps P1 bodies, raw MCQ choices, and glossary files', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wb = seedWorkbook(dataDir);
  const contentDir = path.join(wb.dir, 'content');
  fs.appendFileSync(path.join(contentDir, '01-coding-basics.md'),
    '\n@@q id=m1 company=acme-capital topic="Coding" type=mcq diff=1 chapter=coding-basics\n'
    + 'Which event goes first?\n@@choices\n- [ ] Start\n- [x] End\n- [ ] Neither\n@@answer\nEnd.\n');
  const glossary = { name: 'glossary-coding.txt', text: 'sweep line | Process sorted events.\n' };
  fs.writeFileSync(path.join(contentDir, glossary.name), glossary.text);
  const content = bridge.readWorkbook(dataDir, wb.id);
  assert.equal(content.questions[0].prompt, 'Return the peak number of overlapping intervals.');
  assert.deepEqual(content.questions[0].choices, []);
  assert.deepEqual(content.questions[3].choices, ['Start', 'End', 'Neither']);
  assert.equal(content.questions[3].prompt, 'Which event goes first?');
  assert.match(content.chapters[0].body, /A sweep line turns intervals/);
  assert.deepEqual(content.glossary, [glossary]);
  assert.equal(bridge.workbookExists(dataDir, '../outside'), false);
});

test('lintMarkup retains bad-id, malformed tests, and missing reference errors', () => {
  const text = markup.renderChapter({
    companySlug: 'acme-capital', sessions: [],
    questions: [{ qid: 'iv-202603140930-1', item: { ...ITEM, type: 'code' }, date: '2026-03-14', round: 'coding' }],
  });
  assert.deepEqual(bridge.lintMarkup(text, 'check.md'), []);
  const cases = [
    [text.replace('id=iv-202603140930-1', 'id=iv_bad'), 'bad-id'],
    [text.replace('@@answer', '@@tests\nnot json\n@@answer'), 'code-tests'],
    [text.replace('@@answer', '@@tests\n{"entry":"peak","cases":[{"args":[],"expect":0}]}\n@@answer'), 'code-reference'],
  ];
  for (const [bad, rule] of cases) {
    const findings = bridge.lintMarkup(bad, 'check.md');
    assert.ok(findings.some((f) => f.rule === rule && f.file === 'check.md'));
    assert.ok(findings.every((f) => f.severity === 'error'));
  }
});

test('readMasterResume and renderResumeMarkdown use an existing P2 master', (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const master = { contact: { name: 'Test Candidate' }, headline: 'Software Engineer', summary: 'Build reliable tools.' };
  fs.mkdirSync(path.join(dataDir, 'resume'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'resume', 'master.json'), JSON.stringify(master));
  assert.deepEqual(resume.readMasterResume(dataDir), master);
  assert.equal(resume.renderResumeMarkdown(master), '# Test Candidate\n\n**Software Engineer**\n\n## Summary\n\nBuild reliable tools.\n');
});
