const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/podcast/store');
const topics = require('../lib/podcast/topics');
const { pickConcepts } = require('../lib/podcast/picker');
const { materialText } = require('../lib/podcast/script');

const q = (id, topic, prompt, extra = {}) => ({ id, chapter: 'c1', topic, type: 'written', diff: 'medium', prompt, rubric: `Strong answer for ${prompt}`, answer: '', ...extra });

// Two live roles with workbooks, one closed role with a workbook, one live role without.
function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-topics-'));
  const w = (rel, v) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), JSON.stringify(v)); };
  w('role-tracker.json', { 'Rippling|SWE': { stage: 'onsite' }, 'Mercor|FS': { stage: 'applied' }, 'Old|Gone': { stage: 'rejected' } });
  w('role-actions.json', { saved: ['Linear|PE'], skipped: [], applied: [] });
  w('workbooks/rippling-swe/meta.json', { id: 'rippling-swe', roleKeys: ['Rippling|SWE'], status: 'ready' });
  w('workbooks/mercor-fs/meta.json', { id: 'mercor-fs', roleKeys: ['Mercor|FS'], status: 'ready' });
  w('workbooks/old-gone/meta.json', { id: 'old-gone', roleKeys: ['Old|Gone'], status: 'ready' });
  const books = {
    'rippling-swe': { chapters: [{ id: 'c1', topic: 'System design', title: 'Designing the sync pipeline', body: 'Fan out with a queue.' }, { id: 'c2', topic: 'Algorithms', title: 'Graphs', body: 'Kahn first.' }],
      questions: [q('r1', 'System design', 'Design a payroll sync'), q('r2', 'System design', 'Shard the audit log'), q('r3', 'Algorithms', 'Topological order of jobs'), q('r4', 'Company', 'Why Rippling?'), q('r5', 'Algorithms', 'Detect a cycle in a DAG')] },
    'mercor-fs': { chapters: [{ id: 'c1', topic: 'Algorithms and breadth', title: 'Breadth', body: 'BFS on grids.' }, { id: 'c2', topic: 'System design', title: 'RL environments', body: 'Queue of jobs.' }],
      questions: [q('m1', 'Algorithms and breadth', 'Shortest path in a grid'), q('m2', 'System design', 'Design the grader queue'), q('m4', 'System design', 'Design the eval store'), q('m3', 'Event logs', 'Count overlapping holds')] },
    'old-gone': { chapters: [], questions: [q('o1', 'System design', 'Dead question'), q('o2', 'Probability', 'Dead probability')] },
  };
  const readWorkbook = (dir, id) => { if (!books[id]) throw new Error('no such workbook'); return books[id]; };
  return { d, readWorkbook };
}

test('topics are aggregated across the live roles\' workbook questions, merged by name and ranked by how much the interviews need them', () => {
  const { d, readWorkbook } = fixture();
  const r = topics.rankTopics(d, { readWorkbook });
  const titles = r.topics.map((t) => t.title);
  assert.ok(!titles.some((t) => /company/i.test(t)), 'company-pitch topics are not concepts');
  assert.ok(!titles.some((t) => /probability/i.test(t)), 'closed roles contribute nothing');
  const sd = r.topics.find((t) => /system design/i.test(t.title));
  const alg = r.topics.find((t) => /algorithms/i.test(t.title));
  assert.ok(sd && alg, titles.join(' | '));
  assert.strictEqual(sd.roleCount, 2);
  assert.strictEqual(sd.questionCount, 4, 'the closed role\'s system design question is excluded');
  assert.strictEqual(alg.questionCount, 3, '"Algorithms" and "Algorithms and breadth" merge into one topic');
  assert.strictEqual(r.topics[0].title, sd.title, 'the topic every live interview needs ranks first');
  assert.ok(sd.importance > alg.importance && alg.importance > r.topics.find((t) => /event logs/i.test(t.title)).importance);
  assert.ok(sd.questions.every((x) => x.prompt && x.workbookId));
  assert.ok(fs.existsSync(path.join(d, 'podcast', 'topics.json')));
});

test('a topic sheet is built from that topic\'s chapters and questions, validated, cached, and rebuilt only when the source changes', async () => {
  const { d, readWorkbook } = fixture();
  const r = topics.rankTopics(d, { readWorkbook });
  const sd = r.topics[0];
  let calls = 0;
  const runAgentFn = async ({ cwd, prompt }) => {
    calls++;
    assert.match(prompt, /Design a payroll sync/);
    assert.match(prompt, /Fan out with a queue/);
    assert.ok(!/Rippling|Mercor/.test(prompt), 'the sheet writer never sees company names');
    fs.writeFileSync(path.join(cwd, 'sheet.out.json'), JSON.stringify({ cards: [
      { title: 'Start from the write path', category: 'design', bullets: ['Say what is written first.', 'Then who reads it.', 'Then what breaks at ten times the load.', 'Name the queue before the database.'] },
      { title: 'Shard by tenant', category: 'design', bullets: ['One tenant never spans shards.', 'Hot tenants get their own.', 'Rebalance offline.', 'Say the key out loud.'] },
      { title: 'The trap: one big table', category: 'design', bullets: ['A single table hides the hot partition.', 'It fails at the first big tenant.', 'Name the partition key before the schema.', 'Then the index.'] },
    ] }));
    return { ok: true };
  };
  const built = await topics.buildTopicSheet({ dataDir: d, topic: sd, readWorkbook, runAgentFn });
  assert.ok(built.ok, built.error);
  assert.strictEqual(built.cards.length, 3);
  const file = topics.topicSheetFile(d, sd.id);
  assert.ok(fs.existsSync(file));
  const again = await topics.buildTopicSheet({ dataDir: d, topic: sd, readWorkbook, runAgentFn });
  assert.ok(again.cached && calls === 1, 'an unchanged topic reuses its sheet');

  const bad = async ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'sheet.out.json'), JSON.stringify({ cards: [{ title: 'x', category: 'nope', bullets: ['one'] }] })); return { ok: true }; };
  const alg = r.topics.find((t) => /algorithms/i.test(t.title));
  const rejected = await topics.buildTopicSheet({ dataDir: d, topic: alg, readWorkbook, runAgentFn: bad });
  assert.ok(!rejected.ok && /category|bullets/.test(rejected.error));
  assert.ok(!fs.existsSync(topics.topicSheetFile(d, alg.id)), 'a rejected sheet is not saved');
  assert.deepStrictEqual(topics.missingTopicSheets(d, r).map((t) => t.title), r.topics.filter((t) => t.id !== sd.id).map((t) => t.title));
});

test('episodes are built from the top-ranked topics with their sheets, not from past interviews', async () => {
  const { d, readWorkbook } = fixture();
  const r = topics.rankTopics(d, { readWorkbook });
  for (const t of r.topics) {
    await topics.buildTopicSheet({ dataDir: d, topic: t, readWorkbook, runAgentFn: async ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'sheet.out.json'), JSON.stringify({ cards: [1, 2, 3].map((n) => ({ title: `${t.title} rule ${n}`, category: 'fundamentals', bullets: ['a.', 'b.', 'c.', 'd.'] })) })); return { ok: true }; } });
  }
  // A weak spot from a past interview exists and must not be picked.
  fs.mkdirSync(path.join(d, 'interview-work', 'sessions', '2026-10-14_0900'), { recursive: true });
  fs.writeFileSync(path.join(d, 'interview-work', 'sessions', '2026-10-14_0900', 'analysis.json'), JSON.stringify({ asked: [], weakSpots: [{ label: 'The library question again' }] }));
  const sheets = topics.readTopicSheets(d, r);
  const master = { cards: [{ id: 'mc1', title: 'A master card', category: 'warmup', bullets: ['x'], companies: ['Rippling'], shared: false, priority: 50 }] };
  const picked = pickConcepts({ dataDir: d, master, topics: sheets, today: '2026-10-15', now: new Date('2026-10-15T12:00:00Z'), readWorkbook, counts: { topics: 2, review: 0 } });
  assert.strictEqual(picked.weak.length, 0);
  assert.strictEqual(picked.cards.length, 0, 'master cards stay out once topic sheets exist');
  assert.deepStrictEqual(picked.topics.map((t) => t.title), r.topics.slice(0, 2).map((t) => t.title));
  assert.ok(picked.topics[0].cards.length === 3 && picked.topics[0].questions.length >= 1);
  assert.strictEqual(picked.all.length, 2);

  // Once aired, a topic is held back and the next one in the ranking comes up.
  store.recordAired(d, [r.topics[0].id], '2026-10-15');
  const next = pickConcepts({ dataDir: d, master: { cards: [] }, topics: sheets, today: '2026-10-16', now: new Date('2026-10-16T12:00:00Z'), readWorkbook, counts: { topics: 2, review: 0 } });
  assert.ok(!next.topics.some((t) => t.id === r.topics[0].id));

  const m = materialText({ ...picked, cards: [], review: [] });
  assert.match(m, /Anticipated questions/);
  assert.match(m, /Design a payroll sync/);
  assert.ok(!/Rippling|Mercor/.test(m));
});

test('topic names that differ by wording are merged, behavioral is not a concept, and an agent grouping is applied when cached', async () => {
  const { d, readWorkbook: base } = fixture();
  const books = {
    'rippling-swe': { chapters: [], questions: [q('r1', 'Hash maps and running aggregates', 'Running sum per key'), q('r2', 'Behavioral', 'Tell me about a conflict'), q('r3', 'Complexity analysis', 'Big O of this loop')] },
    'mercor-fs': { chapters: [], questions: [q('m1', 'Hash maps and counting', 'Count the words'), q('m2', 'Tradeoffs and complexity under questioning', 'Why is this n log n?')] },
    'old-gone': { chapters: [], questions: [] },
  };
  const readWorkbook = (dir, id) => books[id] || base(dir, id);
  let r = topics.rankTopics(d, { readWorkbook });
  let titles = r.topics.map((t) => t.title);
  assert.ok(!titles.some((t) => /behavioral/i.test(t)), titles.join(' | '));
  assert.strictEqual(titles.filter((t) => /hash maps/i.test(t)).length, 1, 'wording variants of the same concept merge: ' + titles.join(' | '));
  assert.strictEqual(titles.filter((t) => /complexity/i.test(t)).length, 2, 'without an agent grouping, differently worded complexity topics stay apart');

  // An agent pass groups the remaining variants under one plain name; it is cached by the set of names.
  let calls = 0;
  const runAgentFn = async ({ cwd, prompt }) => {
    calls++;
    assert.match(prompt, /Complexity analysis/);
    fs.writeFileSync(path.join(cwd, 'topic-groups.out.json'), JSON.stringify([{ title: 'Complexity and tradeoffs', members: ['Complexity analysis', 'Tradeoffs and complexity under questioning'] }]));
    return { ok: true };
  };
  const g = await topics.buildTopicGroups({ dataDir: d, ranking: r, runAgentFn });
  assert.ok(g.ok && g.groups === 1, JSON.stringify(g));
  r = topics.rankTopics(d, { readWorkbook });
  titles = r.topics.map((t) => t.title);
  assert.ok(titles.includes('Complexity and tradeoffs') && titles.filter((t) => /complexity/i.test(t)).length === 1, titles.join(' | '));
  assert.strictEqual(r.topics.find((t) => t.title === 'Complexity and tradeoffs').questionCount, 2);
  const again = await topics.buildTopicGroups({ dataDir: d, ranking: r, runAgentFn });
  assert.ok(again.cached && calls === 1, 'the grouping is reused while the topic names are unchanged');
});

test('every episode reserves slots for algorithm topics and covers four topics by default', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-algo-'));
  const sheet = (cat) => [1, 2, 3].map((n) => ({ title: `idea ${n}`, category: cat, bullets: ['a.', 'b.', 'c.', 'd.'] }));
  const mk = (title, importance, cat) => ({ id: require('../lib/podcast/store').shortHash(title), title, importance, roleCount: 1, questionCount: 3, questions: [{ prompt: `${title}?`, answer: 'a', type: 'written' }], cards: sheet(cat) });
  const pool = [
    mk('Backend and system design', 300, 'design'), mk('Complexity and tradeoffs', 200, 'fundamentals'), mk('API design', 150, 'design'),
    mk('Exact money arithmetic', 120, 'fundamentals'), mk('Graph traversal and ordering', 60, 'algorithms'), mk('Hash maps and counting', 50, 'algorithms'), mk('Intervals', 10, 'algorithms'),
  ];
  const p = pickConcepts({ dataDir: d, master: { cards: [] }, topics: pool, today: '2026-10-17', now: new Date('2026-10-17T12:00:00Z') });
  assert.strictEqual(p.topics.length, 4);
  const algo = p.topics.filter((t) => topics.isAlgorithmTopic(t));
  assert.strictEqual(algo.length, 2, p.topics.map((t) => t.title).join(' | '));
  assert.deepStrictEqual(algo.map((t) => t.title), ['Graph traversal and ordering', 'Hash maps and counting']);
  assert.ok(p.topics.some((t) => t.title === 'Backend and system design'));

  // Day over day the algorithm slots move down the list once the top ones have aired.
  store.recordAired(d, p.topics.map((t) => t.id), '2026-10-17');
  const next = pickConcepts({ dataDir: d, master: { cards: [] }, topics: pool, today: '2026-10-18', now: new Date('2026-10-18T12:00:00Z') });
  assert.ok(next.topics.some((t) => t.title === 'Intervals'), next.topics.map((t) => t.title).join(' | '));
});

test('algorithm topics are recognized by name before a sheet exists and their sheets are built first', () => {
  assert.ok(topics.isAlgorithmTopic({ title: 'Sorting and heaps' }));
  assert.ok(topics.isAlgorithmTopic({ title: 'Stacks and tree traversal' }));
  assert.ok(!topics.isAlgorithmTopic({ title: 'Backend and system design' }));
  assert.ok(!topics.isAlgorithmTopic({ title: 'Exact money arithmetic' }));
  assert.ok(topics.isAlgorithmTopic({ title: 'Odd name', cards: [{ category: 'algorithms' }, { category: 'algorithms' }, { category: 'design' }] }));
  const { d, readWorkbook } = fixture();
  const r = topics.rankTopics(d, { readWorkbook });
  const order = topics.missingTopicSheets(d, r).map((t) => t.title);
  const firstNonAlgo = order.findIndex((t) => !topics.isAlgorithmTopic({ title: t }));
  assert.ok(order.slice(firstNonAlgo).every((t) => !topics.isAlgorithmTopic({ title: t })), order.join(' | '));
});

test('the brief carries the previous episode\'s rules so the new one opens with a spaced retrieval check', () => {
  const m = materialText({ weak: [], topics: [], cards: [], review: [], recall: ['Index at write time.', 'Sort by start, compare to the last end.'] });
  assert.match(m, /Rules from the last episode/);
  assert.match(m, /Index at write time\./);
  assert.ok(!/Rules from the last episode/.test(materialText({ weak: [], topics: [], cards: [], review: [], recall: [] })));
  const { previousTakeaways } = require('../lib/podcast/episode');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-recall-'));
  store.writeJson(path.join(store.episodeDir(d, '2026-10-15'), 'episode.json'), { date: '2026-10-15', status: 'ready', takeaways: ['old rule'] });
  store.writeJson(path.join(store.episodeDir(d, '2026-10-16'), 'episode.json'), { date: '2026-10-16', status: 'ready', takeaways: ['rule a', 'rule b'] });
  store.writeJson(path.join(store.episodeDir(d, '2026-10-17'), 'episode.json'), { date: '2026-10-17', status: 'failed' });
  assert.deepStrictEqual(previousTakeaways(d, '2026-10-17'), ['rule a', 'rule b']);
  assert.deepStrictEqual(previousTakeaways(d, '2026-10-16'), ['old rule'], 'a regenerated day recalls the day before, not itself');
});

test('a new workbook does not throw away the topic grouping: known names keep their groups and only new names trigger a regroup', async () => {
  const { d, readWorkbook: base } = fixture();
  const books = {
    'rippling-swe': { chapters: [], questions: [q('r1', 'Complexity analysis', 'Big O of this loop')] },
    'mercor-fs': { chapters: [], questions: [q('m1', 'Tradeoffs and complexity under questioning', 'Why n log n?')] },
    'old-gone': { chapters: [], questions: [] },
  };
  let readWorkbook = (dir, id) => books[id] || base(dir, id);
  let r = topics.rankTopics(d, { readWorkbook });
  let calls = 0;
  const runAgentFn = async ({ cwd }) => { calls++; fs.writeFileSync(path.join(cwd, 'topic-groups.out.json'), JSON.stringify([{ title: 'Complexity and tradeoffs', members: ['Complexity analysis', 'Tradeoffs and complexity under questioning'] }])); return { ok: true }; };
  await topics.buildTopicGroups({ dataDir: d, ranking: r, runAgentFn });

  // A third role's workbook arrives with a brand-new topic name.
  books['mercor-fs'].questions.push(q('m9', 'Bit manipulation', 'Count set bits'));
  r = topics.rankTopics(d, { readWorkbook });
  assert.ok(r.topics.some((t) => t.title === 'Complexity and tradeoffs'), 'existing groups still apply: ' + r.topics.map((t) => t.title).join(' | '));
  const again = await topics.buildTopicGroups({ dataDir: d, ranking: r, runAgentFn });
  assert.strictEqual(calls, 2, 'a new name triggers one regroup');
  const third = await topics.buildTopicGroups({ dataDir: d, ranking: topics.rankTopics(d, { readWorkbook }), runAgentFn });
  assert.ok(third.cached && calls === 2, 'and then it is cached again');
});
