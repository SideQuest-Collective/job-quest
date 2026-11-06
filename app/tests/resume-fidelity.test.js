// app/tests/resume-fidelity.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isQuantified, summaryCore, headlineTitle, baseSelection, describeBase, wordEditRatio, jdPhrases, shingles, checkFidelity,
} = require('../lib/resume/fidelity');
const { scoreExtracted, loadTellWords } = require('../lib/resume/grade');
const { loadMaster, loadKeywords, jdText, identityTailored, syntheticExtract } = require('./helpers/resume-fixtures');

const master = loadMaster();
const keywords = loadKeywords();
const jd = jdText();
const tellWords = loadTellWords();
const fid = (t, m = master) => checkFidelity({ master: m, tailored: t, jd, keywords });
const failed = (r) => r.checks.filter((c) => !c.pass).map((c) => c.id);
const role = (t, id) => t.experience[0].roles.find((r) => r.id === id);

// What the grader would extract from a rendered tailored resume.
function extractOf(t) {
  const roles = (id) => role(t, id).bullets.map((b) => ({ id: b.src, text: b.text }));
  return syntheticExtract({
    ...master,
    headline: t.headline,
    summary: t.summary,
    experience: master.experience.map((e) => ({ ...e, roles: e.roles.map((r) => ({ ...r, bullets: roles(r.id) })) })),
    projects: master.projects.filter((p) => t.projects.some((tp) => tp.id === p.id))
      .map((p) => ({ ...p, bullets: t.projects.find((tp) => tp.id === p.id).bullets })),
    skills: t.skills,
  });
}

test('a digit makes a bullet quantified, a year alone does not', () => {
  assert.equal(isQuantified('Cut latency from 900ms to 250ms.'), true);
  assert.equal(isQuantified('Led the launch across 4 teams.'), true);
  assert.equal(isQuantified('Mentored two engineers (2026).'), false);
  assert.equal(isQuantified('Built an identity matching pipeline.'), false);
});

test('summaryCore is every sentence but the first and last; headlineTitle is the text before |', () => {
  assert.deepEqual(summaryCore('One. Two has 3.5 points. Three! Four?'), ['Two has 3.5 points.', 'Three!']);
  assert.deepEqual(summaryCore('One. Two.'), []);
  assert.equal(headlineTitle('Senior Software Engineer | Backend Systems'), 'Senior Software Engineer');
});

test('the base keeps the quantified experience bullets and the first bullet of the first 2 projects', () => {
  const m = loadMaster();
  m.experience[0].roles[0].bullets[1].tailor = false;
  m.projects[0].bullets[0].tailor = false;
  const base = baseSelection(m);
  assert.deepEqual(base.roles[0].bullets, ['exp.sr.1', 'exp.sr.3', 'exp.sr.4', 'exp.sr.5']);
  assert.deepEqual(base.projects.map((p) => p.bullets[0]), ['proj.relay.1']);
  assert.ok(!base.keep.includes('exp.sr.2'), 'an excluded bullet is never required');
  assert.equal(base.keep.length, 12);
  const text = describeBase(m);
  assert.match(text, /Role `sr` \(Senior Software Engineer\): exp\.sr\.1 \[keep\], exp\.sr\.3 \[keep\]/);
  assert.match(text, /Headline title to keep before the \|: "Senior Software Engineer"/);
  assert.match(text, /1\. Built a billing platform of 6 services/);
  assert.ok(!text.includes('exp.sr.2') && !text.includes('proj.pantry'));
});

test('unquantified bullets and later projects are optional add-ins, not base', () => {
  const m = loadMaster();
  m.experience[0].roles[0].bullets.push({ id: 'exp.sr.9', text: 'Mentored engineers through design reviews (2026).' });
  m.projects.push({ id: 'proj.c', name: 'C', tech: [], bullets: [{ id: 'proj.c.1', text: 'Built C.' }] });
  const base = baseSelection(m);
  assert.ok(!base.roles[0].bullets.includes('exp.sr.9'));
  assert.deepEqual(base.roles[0].optional, ['exp.sr.9']);
  assert.ok(!base.ids.has('exp.sr.9') && !base.ids.has('proj.c.1'));
  assert.deepEqual(base.projects.map((p) => p.id), ['proj.pantry', 'proj.relay']);
  assert.deepEqual(base.optionalProjects.map((p) => p.id), ['proj.c']);
  const text = describeBase(m);
  assert.match(text, /Optional add-ins \(at most 2 in total/);
  assert.match(text, /- Role `sr`: exp\.sr\.9/);
  assert.match(text, /- Projects: proj\.c \(C\)/);
  const t = identityTailored(m);
  const r = fid(t, m);
  assert.deepEqual(r.fidelity.swaps, ['exp.sr.9', 'proj.relay.2', 'proj.c.1']);
  assert.equal(r.F, 27, 'a third add-in costs 3');
});

test('word edit ratio and JD phrase runs', () => {
  assert.equal(wordEditRatio('Built a Kafka pipeline.', 'Built a Kafka pipeline'), 0);
  assert.equal(wordEditRatio('Built a Kafka pipeline', 'Built the Kafka pipeline'), 0.25);
  const jdSet = shingles('We want someone to own data stores in PostgreSQL and Redis for our merchants.');
  assert.deepEqual(jdPhrases('Built 4 services and now own data stores in PostgreSQL and Redis daily.', jdSet, new Set()),
    ['own data stores in postgresql and redis']);
  assert.deepEqual(jdPhrases('Uses Postgres and Redis for our team.', jdSet, new Set()), [], '"and redis for our" has one content word');
  assert.deepEqual(jdPhrases('Platform Engineer | Own data stores', shingles('Platform Engineer own data stores'), new Set()), [], 'no run crosses a |');
  assert.deepEqual(jdPhrases('own data stores in PostgreSQL', jdSet, shingles('own data stores in PostgreSQL')), []);
});

test('the identity resume keeps all 30 fidelity points', () => {
  const r = fid(identityTailored(master));
  assert.equal(r.F, 30);
  assert.deepEqual(failed(r), []);
  assert.deepEqual(r.checks.map((c) => c.id), ['quantified-kept', 'bullets-verbatim', 'no-jd-phrases', 'headline-title', 'summary-core', 'swaps']);
});

test('the allowed edits cost nothing: headline focus, first and last summary sentence, order, 2 swaps, skill order', () => {
  const t = identityTailored(master);
  t.headline = 'Senior Software Engineer | Payments Infrastructure & Event Streams';
  const core = summaryCore(master.summary);
  t.summary = ['Backend engineer with 8+ years on AWS payment services.', ...core, 'Looking to build payment services that merchants rely on.'].join(' ');
  role(t, 'sr').bullets.reverse();
  t.projects = [{ id: 'proj.relay', bullets: [{ src: 'proj.relay.2', text: master.projects[1].bullets[1].text }] }];
  t.skills.reverse();
  const r = fid(t);
  assert.equal(r.F, 30, JSON.stringify(r.checks));
  assert.deepEqual(r.fidelity.swaps, ['proj.relay.2']);
});

test('each quantified bullet left out costs 5', () => {
  const t = identityTailored(master);
  role(t, 'sr').bullets.splice(1, 2);
  const r = fid(t);
  assert.equal(r.F, 20);
  assert.deepEqual(r.fidelity.dropped, ['exp.sr.2', 'exp.sr.3']);
  assert.equal(r.checks.find((c) => c.id === 'quantified-kept').detail, 'left out: exp.sr.2, exp.sr.3');
});

test('a JD phrase bolted onto a real bullet costs 3 for the rewrite and 3 for the phrase', () => {
  const t = identityTailored(master);
  role(t, 'ii').bullets[1].text += ' so the team could feed reporting data into Redshift for finance and analytics partners';
  const r = fid(t);
  assert.deepEqual(failed(r), ['bullets-verbatim', 'no-jd-phrases']);
  assert.equal(r.F, 24);
  assert.deepEqual(r.fidelity.jdPhrases, [{ where: 'exp.ii.2', phrases: ['feed reporting data into redshift for finance and analytics partners'] }]);
  assert.match(r.checks.find((c) => c.id === 'bullets-verbatim').detail, /^exp\.ii\.2 \(\d+% of words changed\)$/);
});

test('a light word change stays verbatim; rewording many bullets costs 3 each', () => {
  const t = identityTailored(master);
  role(t, 'sr').bullets[0].text = role(t, 'sr').bullets[0].text.replace('Designed and built', 'Built');
  assert.equal(fid(t).F, 30);
  for (const b of role(t, 'i').bullets) b.text = `Owned work where I ${b.text.toLowerCase()}`;
  const r = fid(t);
  assert.equal(r.fidelity.rewritten.length, 4);
  assert.equal(r.F, 18);
});

test('re-titling the headline costs 5, whether by changing the title or using the job title', () => {
  const t = identityTailored(master);
  t.headline = 'Staff Payments Engineer | Backend Systems';
  assert.equal(fid(t).checks.find((c) => c.id === 'headline-title').detail, 'the headline should start with "Senior Software Engineer"');
  assert.equal(fid(t).F, 25);
  const m = loadMaster();
  m.headline = 'Backend Systems & Data Platforms';
  t.headline = 'Senior Software Engineer, Payments Platform';
  const r = checkFidelity({ master: m, tailored: t, jd, keywords: { ...keywords, title: 'Senior Software Engineer, Payments Platform' } });
  assert.ok(failed(r).includes('headline-title'));
  assert.equal(r.checks.find((c) => c.id === 'headline-title').detail, 'the headline uses the job title "Senior Software Engineer, Payments Platform"');
});

test('changing a middle summary sentence or adding sentences costs 5', () => {
  const t = identityTailored(master);
  t.summary = master.summary.replace('cut compute costs by 35%', 'cut costs by 35%');
  assert.deepEqual(failed(fid(t)), ['summary-core']);
  assert.equal(fid(t).F, 25);
  t.summary = `${master.summary} Also loves Kafka. And Redis.`;
  assert.match(fid(t).checks.find((c) => c.id === 'summary-core').detail, /^6 sentences/);
});

test('swaps beyond 2 cost 3 each', () => {
  const t = identityTailored(master);
  t.projects = [
    { id: 'proj.pantry', bullets: [{ src: 'proj.pantry.1', text: master.projects[0].bullets[0].text }] },
    { id: 'proj.relay', bullets: master.projects[1].bullets.map((b) => ({ src: b.id, text: b.text })) },
  ];
  assert.equal(fid(t).F, 30);
  const m = loadMaster();
  m.projects.push(
    { id: 'proj.a', name: 'A', tech: [], bullets: [{ id: 'proj.a.1', text: 'Built A.' }, { id: 'proj.a.2', text: 'Ran A.' }] },
    { id: 'proj.b', name: 'B', tech: [], bullets: [{ id: 'proj.b.1', text: 'Built B.' }] },
  );
  t.projects.push({ id: 'proj.b', bullets: [{ src: 'proj.b.1', text: 'Built B.' }] }, { id: 'proj.a', bullets: [{ src: 'proj.a.2', text: 'Ran A.' }] });
  const r = fid(t, m);
  assert.deepEqual(r.fidelity.swaps, ['proj.relay.2', 'proj.b.1', 'proj.a.2']);
  assert.equal(r.F, 27);
});

test('a keyword-stuffed rewrite scores below the base-first resume even with more keyword hits', () => {
  const kw = { ...keywords, preferred: [...keywords.preferred, { term: 'merchants', alts: [] }, { term: 'reliability', alts: [] }] };
  const light = identityTailored(master);
  light.headline = 'Senior Software Engineer | Payments Infrastructure & Event Streams';
  const heavy = identityTailored(master);
  heavy.headline = 'Senior Software Engineer, Payments Platform | Java Services';
  role(heavy, 'sr').bullets.splice(2, 2);
  role(heavy, 'ii').bullets.splice(3, 1);
  for (const b of role(heavy, 'sr').bullets.slice(0, 2)) b.text += ' to improve their reliability for 40,000 merchants';
  const grade = (t) => scoreExtracted(extractOf(t), { keywords: kw, master, tailored: t, jd, tellWords });
  const a = grade(light);
  const b = grade(heavy);
  assert.ok(b.categories.K > a.categories.K, `heavy K ${b.categories.K} vs light K ${a.categories.K}`);
  assert.ok(b.total < a.total - 15, `heavy ${b.total} vs light ${a.total}`);
  assert.ok(a.total >= 90, String(a.total));
  assert.deepEqual(b.fidelity.dropped, ['exp.sr.3', 'exp.sr.4', 'exp.ii.4']);
});
