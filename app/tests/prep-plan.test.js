// app/tests/prep-plan.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPlan } = require('../lib/prep/plan');
const { addProblems } = require('../lib/prep/problems');
const { withServer } = require('./helpers/server');
const store = require('../lib/workbook/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prep-plan-'));
const readDay = (dir, date) => JSON.parse(fs.readFileSync(path.join(dir, 'tasks', `${date}.json`), 'utf-8'));
const ctx = (extra = {}) => ({
  today: '2026-10-06', workbookExists: (id) => id === 'acme-swe', problemExists: (id) => id === 'acme-drill',
  sdTopicExists: (id) => id === 'url-shortener', ...extra,
});

test('applyPlan writes dated tasks with links beside tasks from other sources', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', '2026-10-07.json'), JSON.stringify({ date: '2026-10-07', tasks: [{ text: 'Interview follow-up', category: 'application', completed: false, source: 'interview' }] }));
  const r = applyPlan(dir, { planId: 'week-1', tasks: [
    { date: '2026-10-07', text: 'Read the caching chapter', category: 'system-design', minutes: 30, roleKey: 'Acme|SWE', link: { kind: 'workbook', workbookId: 'acme-swe', chapter: 's-cache' } },
    { date: '2026-10-07', text: 'Drill A, timed', category: 'coding', minutes: 40, link: { kind: 'codelab', problemId: 'acme-drill' }, content: 'Parts 1-3.' },
    { date: '2026-10-08', text: 'Mock design round', category: 'system-design', link: { kind: 'sysdesign', topicId: 'url-shortener' } },
  ] }, ctx());
  assert.deepEqual(r, { planId: 'week-1', added: 3, removed: 0, kept: 0, days: 2 });
  const d7 = readDay(dir, '2026-10-07');
  assert.equal(d7.tasks[0].source, 'interview');
  assert.deepEqual(d7.tasks[1], { text: 'Read the caching chapter', category: 'system-design', completed: false, content: '', source: 'prep-plan', planId: 'week-1', minutes: 30, roleKey: 'Acme|SWE', link: { kind: 'workbook', workbookId: 'acme-swe', chapter: 's-cache' } });
  assert.equal(d7.tasks[2].problemId, 'acme-drill');
  assert.equal(readDay(dir, '2026-10-08').tasks[0].link.topicId, 'url-shortener');
});

test('re-applying a plan replaces its unfinished tasks, keeps finished ones, and leaves other plans alone', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  applyPlan(dir, { planId: 'week-1', tasks: [
    { date: '2026-10-07', text: 'Done already', category: 'coding' },
    { date: '2026-10-07', text: 'Old step', category: 'research' },
    { date: '2026-10-09', text: 'Dropped later', category: 'research' },
  ] }, ctx());
  applyPlan(dir, { planId: 'other', tasks: [{ date: '2026-10-09', text: 'Other plan', category: 'research' }] }, ctx());
  const file = path.join(dir, 'tasks', '2026-10-07.json');
  const day = JSON.parse(fs.readFileSync(file, 'utf-8'));
  day.tasks[0].completed = true;
  fs.writeFileSync(file, JSON.stringify(day));
  const r = applyPlan(dir, { planId: 'week-1', tasks: [
    { date: '2026-10-07', text: 'Done already', category: 'coding' },
    { date: '2026-10-07', text: 'New step', category: 'research' },
  ] }, ctx());
  assert.deepEqual(r, { planId: 'week-1', added: 1, removed: 2, kept: 1, days: 1 });
  assert.deepEqual(readDay(dir, '2026-10-07').tasks.map((x) => [x.text, x.completed]), [['Done already', true], ['New step', false]]);
  assert.deepEqual(readDay(dir, '2026-10-09').tasks.map((x) => x.text), ['Other plan']);
});

test('applyPlan validates every task before writing anything', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = [
    [{ planId: 'Bad Id', tasks: [] }, /planId/],
    [{ planId: 'p', tasks: [{ date: '2026-10-05', text: 'x', category: 'coding' }] }, /in the past/],
    [{ planId: 'p', tasks: [{ date: '2026-13-01', text: 'x', category: 'coding' }] }, /YYYY-MM-DD/],
    [{ planId: 'p', tasks: [{ date: '2026-10-07', text: 'x', category: 'reading' }] }, /category/],
    [{ planId: 'p', tasks: [{ date: '2026-10-07', text: 'x', category: 'coding', link: { kind: 'workbook', workbookId: 'nope' } }] }, /is not a workbook/],
    [{ planId: 'p', tasks: [{ date: '2026-10-07', text: 'x', category: 'coding', link: { kind: 'codelab', problemId: 'nope' } }] }, /not a Code Lab problem/],
    [{ planId: 'p', tasks: [{ date: '2026-10-07', text: 'x', category: 'coding', link: { kind: 'sysdesign', topicId: 'nope' } }] }, /not a System Design topic/],
    [{ planId: 'p', tasks: [{ date: '2026-10-07', text: 'ok', category: 'coding' }, { date: '2026-10-08', text: '', category: 'coding' }] }, /text/],
  ];
  for (const [body, re] of bad) assert.throws(() => applyPlan(dir, body, ctx()), re);
  assert.equal(fs.existsSync(path.join(dir, 'tasks')), false);
});

const drill = (extra = {}) => ({
  id: 'acme-counter', title: 'Counter', category: 'acme-practice', difficulty: 'medium',
  description: 'Count things.', starterCode: 'def count(xs):\n    pass\n', functionName: 'count',
  referenceSolution: 'def count(xs):\n    return len(xs)\n',
  testCases: [{ input: { xs: [1, 2] }, expected: 2 }, { input: { xs: [] }, expected: 0 }], tags: ['acme'], ...extra,
});

test('addProblems stores verified drills without the reference solution and adds the category', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'problems'));
  fs.writeFileSync(path.join(dir, 'problems', 'problems.json'), JSON.stringify({ categories: [{ id: 'graphs', name: 'Graphs', order: 4 }], problems: [{ id: 'old', order: 7 }] }));
  const seen = [];
  const r = addProblems(dir, { problems: [drill()] }, { runTests: (code, fn, tests) => { seen.push(fn); return { results: tests.map((_, index) => ({ index, passed: true })) }; } });
  assert.deepEqual(r, { added: ['acme-counter'], tests: 2 });
  assert.deepEqual(seen, ['count']);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'problems', 'problems.json'), 'utf-8'));
  assert.deepEqual(data.categories[1], { id: 'acme-practice', name: 'Acme Practice', order: 5 });
  const p = data.problems[1];
  assert.equal(p.order, 8);
  assert.equal(p.referenceSolution, undefined);
  assert.deepEqual(Object.keys(p).sort(), ['category', 'constraints', 'description', 'difficulty', 'examples', 'functionName', 'hints', 'id', 'order', 'starterCode', 'tags', 'testCases', 'title']);
});

test('addProblems refuses a drill whose reference solution fails, and duplicates, writing nothing', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failing = () => ({ results: [{ index: 0, passed: true }, { index: 1, passed: false, expected: '0', actual: '1' }] });
  assert.throws(() => addProblems(dir, { problems: [drill()] }, { runTests: failing }), /fails test 1: expected 0, got 1/);
  assert.throws(() => addProblems(dir, { problems: [drill(), drill()] }, { runTests: failing }), /already exists/);
  assert.throws(() => addProblems(dir, { problems: [drill({ testCases: [{ input: { xs: [] }, expected: 0 }] })] }, { runTests: failing }), /at least 2 tests/);
  assert.throws(() => addProblems(dir, { problems: [drill({ referenceSolution: '' })] }, { runTests: failing }), /referenceSolution/);
  assert.equal(fs.existsSync(path.join(dir, 'problems', 'problems.json')), false);
});

test('server: drills are verified in the real Python runner, then a plan links to them; Tasks offers the links', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.createWorkbook(dir, { roleKeys: ['Acme|SWE'], status: 'ready' });
  const post = async (base, url, body) => { const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { code: r.status, body: await r.json() }; };
  await withServer(dir, async (base) => {
    const broken = await post(base, '/api/problems', { problems: [drill({ referenceSolution: 'def count(xs):\n    return 1\n' })] });
    assert.equal(broken.code, 400);
    assert.match(broken.body.error, /reference solution fails test/);
    const ok = await post(base, '/api/problems', { problems: [drill()] });
    assert.equal(ok.code, 201, JSON.stringify(ok.body));
    const listed = await (await fetch(`${base}/api/problems`)).json();
    assert.ok(listed.problems.some((p) => p.id === 'acme-counter'));
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const plan = await post(base, '/api/tasks/plan', { planId: 'acme-week', tasks: [
      { date, text: 'Drill the counter', category: 'coding', link: { kind: 'codelab', problemId: 'acme-counter' } },
      { date, text: 'Read the guide', category: 'research', link: { kind: 'workbook', workbookId: 'acme-swe' } },
    ] });
    assert.equal(plan.code, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.added, 2);
    const todays = await (await fetch(`${base}/api/tasks/today`)).json();
    assert.deepEqual(todays.tasks.map((x) => x.link.kind), ['codelab', 'workbook']);
    const bad = await post(base, '/api/tasks/plan', { planId: 'acme-week', tasks: [{ date, text: 'x', category: 'coding', link: { kind: 'codelab', problemId: 'missing' } }] });
    assert.equal(bad.code, 400);
  });
});

test('Tasks page opens plan links and shows their details', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  const tasks = html.slice(html.indexOf('function Tasks('), html.indexOf('/* ===== QUIZ ===== */'));
  assert.match(tasks, /window\.open\(`\/workbooks\/\$\{encodeURIComponent\(link\.workbookId\)\}\$\{link\.chapter \? `#read\/\$\{encodeURIComponent\(link\.chapter\)\}` : ''\}`, '_blank', 'noopener'\)/);
  assert.match(tasks, /codeLabInitialProblemRef\.current = link\.problemId;\s*setPage\('codelab'\)/);
  assert.match(tasks, /window\.location\.assign\(`\/\?sd=\$\{encodeURIComponent\(link\.topicId\)\}`\)/);
  assert.match(tasks, /Open workbook &rarr;/);
  assert.match(tasks, /\{linkKind && hasContent && \(/);
});

test('Tasks tabs list upcoming plan days first, then recent past days', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  const tasks = html.slice(html.indexOf('function Tasks('), html.indexOf('/* ===== QUIZ ===== */'));
  assert.match(tasks, /allTasks\.filter\(t => t\.date > todayStamp\)\.sort\(\(a, b\) => a\.date\.localeCompare\(b\.date\)\)\.slice\(0, 7\)/);
  assert.match(tasks, /allTasks\.filter\(t => t\.date < todayStamp\)\.sort\(\(a, b\) => b\.date\.localeCompare\(a\.date\)\)\.slice\(0, 4\)/);
  assert.doesNotMatch(tasks, /allTasks\.slice\(0,7\)/);
});
