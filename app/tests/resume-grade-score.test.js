// app/tests/resume-grade-score.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTellWords, bulletsOf, computeTells, checkContent, scoreExtracted, gradePdf } = require('../lib/resume/grade');
const { DEFAULT_TEMPLATE, renderTex, buildDocument, compileTex, findTectonic } = require('../lib/resume/render');
const { loadMaster, loadKeywords, identityTailored, syntheticExtract, tmpDir } = require('./helpers/resume-fixtures');

const master = loadMaster();
const tellWords = loadTellWords();
const skip = findTectonic() ? false : 'tectonic not installed';

test('the tells list is the 42 grade.py stems', () => {
  assert.equal(tellWords.length, 42);
  assert.equal(tellWords[0], 'leverag');
  assert.equal(tellWords[41], 'excited');
});

test('bulletsOf joins hanging-indent continuation lines and stops at less-indented lines', () => {
  const lines = [
    { text: '• First bullet starts here', x: 25 }, { text: 'and continues here.', x: 31 },
    { text: '• Second bullet.', x: 25 }, { text: 'Software Engineer II – Team', x: 20 }, { text: 'Skills', x: 31 },
  ];
  assert.deepEqual(bulletsOf(lines), ['First bullet starts here and continues here.', 'Second bullet.']);
});

test('every grade.py tell type is detected, in order', () => {
  const lines = [
    { text: 'Summary', x: 20 },
    { text: 'We leverage tools: built APIs, queues, and caches, plus logs, metrics, and traces, from start to finish.', x: 20 },
    { text: 'Experience', x: 20 },
    { text: '• Reliability: shipped end-to-end tests; then more end-to-end work — fast', x: 25 },
  ];
  const ex = { lines, text: lines.map((l) => l.text).join('\n'), pages: 1, fontsEmbedded: true };
  assert.deepEqual(computeTells(ex, tellWords), [
    "'leverag' x1", 'em dash', "'end-to-end' x2", '1 bullets use colon setups', '1 semicolons',
    '2 triad lists in summary', 'colon in summary', "'from X to Y' x1 in summary",
  ]);
});

test('C: a clean resume keeps all 10 points', () => {
  const ex = syntheticExtract();
  const r = checkContent(ex, computeTells(ex, tellWords));
  assert.equal(r.C, 10);
  assert.equal(r.words, 477);
});

test('C: word-range and numeric-bullet penalties', () => {
  const long = syntheticExtract(master, { lines: (L) => [...L, { text: 'word '.repeat(400).trim(), x: 20, y: 0, page: 1 }] });
  assert.equal(checkContent(long, []).C, 8);
  let n = 0;
  const fewNumbers = syntheticExtract(master, {
    lines: (L) => L.map((l) => (l.text.startsWith('•') && n++ < 6 ? { ...l, text: '• Improved the service for customers across every region we support today.' } : l)),
  });
  const r = checkContent(fewNumbers, []);
  assert.equal(r.C, 8);
  assert.equal(r.checks.find((c) => c.id === 'numeric-bullets').detail, '10/16 bullets contain a number');
});

test('C floors at 0', () => {
  const extra = tellWords.slice(0, 12).join(' ');
  const ex = syntheticExtract(master, { lines: (L) => L.map((l) => (l.text === master.summary ? { ...l, text: `${l.text} ${extra}` } : l)) });
  assert.equal(checkContent(ex, computeTells(ex, tellWords)).C, 0);
});

test('scoreExtracted: synthetic master against the fixture keywords scores 98', () => {
  const s = scoreExtracted(syntheticExtract(), { keywords: loadKeywords(), master, tellWords });
  assert.deepEqual(s.categories, { K: 28, P: 30, S: 15, H: 15, C: 10 });
  assert.equal(s.total, 98);
  assert.deepEqual(s.keywords.preferredMiss, ['Terraform']);
  assert.deepEqual(s.tells, []);
  assert.equal(s.words, 477);
  assert.equal(s.pages, 1);
  assert.equal(s.checks.length, 6 + 5 + 3 + 2);
});

test('categories round to one decimal and total rounds the sum', () => {
  const kw = loadKeywords();
  kw.required.push({ term: 'Scala', alts: [] });
  const s = scoreExtracted(syntheticExtract(), { keywords: kw, master, tellWords });
  assert.equal(s.categories.K, 25.8);
  assert.equal(s.total, 96);
});

test('rendered fixture PDF: P, S, H pass, K is 28, total >= 90, identical across 10 runs', { skip, timeout: 300000 }, async () => {
  const dir = tmpDir();
  const texPath = path.join(dir, 'resume.tex');
  fs.writeFileSync(texPath, renderTex(fs.readFileSync(DEFAULT_TEMPLATE, 'utf-8'), buildDocument(master, identityTailored(master))));
  const c = await compileTex({ texPath });
  assert.equal(c.ok, true, c.log);
  const opts = { keywords: loadKeywords(), master, tellWords };
  const first = await gradePdf(c.pdfPath, opts);
  assert.deepEqual(first.checks.filter((x) => !x.pass && x.cat !== 'C'), [], JSON.stringify(first, null, 2));
  assert.equal(first.categories.K, 28, JSON.stringify(first.keywords));
  assert.ok(first.categories.C >= 8, JSON.stringify({ tells: first.tells, checks: first.checks }));
  assert.ok(first.total >= 90, String(first.total));
  for (let i = 0; i < 9; i++) assert.deepEqual(await gradePdf(c.pdfPath, opts), first);
});

test('one compiled PDF per check: each mutation fails the check it targets', { skip, timeout: 900000 }, async () => {
  const tpl = fs.readFileSync(DEFAULT_TEMPLATE, 'utf-8');
  const kw = loadKeywords();
  const base = () => buildDocument(master, identityTailored(master));
  const withDoc = (fn) => { const d = base(); fn(d); return d; };
  const clone = (fn) => { const m = JSON.parse(JSON.stringify(master)); fn(m); return m; };
  async function grade({ doc = base(), edit = (tex) => tex, gradeMaster = master, keywords = kw }) {
    const texPath = path.join(tmpDir(), 'resume.tex');
    fs.writeFileSync(texPath, edit(renderTex(tpl, doc)));
    const c = await compileTex({ texPath });
    assert.equal(c.ok, true, c.log);
    return gradePdf(c.pdfPath, { keywords, master: gradeMaster, tellWords });
  }
  const tiny = withDoc((d) => {
    d.summary = 'Backend engineer.';
    d.projects = [];
    d.skills = d.skills.slice(0, 1);
    for (const r of d.experience[0].roles) r.bullets = r.bullets.slice(0, 1);
  });
  const moveSkillsFirst = (tex) => {
    const s = tex.indexOf('\\section{Skills}');
    const e = tex.indexOf('\\section{Education}');
    const skills = tex.slice(s, e);
    const rest = tex.slice(0, s) + tex.slice(e);
    const x = rest.indexOf('\\section{Experience}');
    return rest.slice(0, x) + skills + rest.slice(x);
  };
  const cases = [
    ['P/one-page', { doc: withDoc((d) => { d.experience[0].roles[0].bullets = Array(45).fill(d.experience[0].roles[0].bullets[0]); }) }],
    ['P/min-words', { doc: tiny }],
    ['P/heading-order', { edit: moveSkillsFirst }],
    ['P/ascii-only', { edit: (tex) => tex.replace('Cut P99 API latency', 'Cut \\textsterling{}5 and P99 API latency') }],
    ['P/contact', { gradeMaster: clone((m) => { m.contact.location = 'Shelbyville, IL'; }) }],
    ['S/heading-summary', { edit: (tex) => tex.replace('\\section{Summary}', '\\section{Profile}') }],
    ['S/target-title', { keywords: { ...kw, title: 'Staff Data Engineer' } }],
    ['H/date-format', { doc: withDoc((d) => { d.experience[0].roles[1].bullets[3] = 'Shipped a REST API in 2021 for 30+ merchants.'; }) }],
    ['H/reverse-chronological', { gradeMaster: clone((m) => { m.experience[0].roles[2].start = '2023-01'; }) }],
    ['H/history-matches-master', { gradeMaster: clone((m) => { m.experience[0].roles[0].title = 'Staff Software Engineer'; }) }],
    ['C/word-range', { doc: tiny }],
    ['C/numeric-bullets', { doc: withDoc((d) => { for (const r of d.experience[0].roles) r.bullets = r.bullets.map(() => 'Improved the service for customers across every region we support today.'); }) }],
  ];
  for (const [id, opts] of cases) {
    const s = await grade(opts);
    const failedIds = s.checks.filter((x) => !x.pass).map((x) => `${x.cat}/${x.id}`);
    assert.ok(failedIds.includes(id), `${id} should fail; failed: ${failedIds.join(', ')}`);
  }
  const tells = await grade({ edit: (tex) => tex.replace('Backend engineer with 8+ years', 'Backend engineer---leveraging 8+ years') });
  assert.ok(tells.tells.includes('em dash'), JSON.stringify(tells.tells));
  assert.ok(tells.tells.includes("'leverag' x1"), JSON.stringify(tells.tells));
  assert.ok(tells.categories.C <= 8);
});
