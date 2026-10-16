const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/podcast/store');
const { buildMaster, missingSheets } = require('../lib/podcast/master');
const { pickConcepts } = require('../lib/podcast/picker');
const { validateScript, wordTargets } = require('../lib/podcast/script');
const tts = require('../lib/podcast/tts');
const { generateEpisode } = require('../lib/podcast/episode');
const { fuzzyFromText } = require('../lib/podcast/fuzzy');

const HOSTS = store.DEFAULT_CONFIG.hosts;
const card = (title, category = 'warmup', lead = 'Say the thing first.') => ({ title, category, bullets: [lead, 'Key number is 45 minutes.', 'Then test.', 'The trap is hedging.'] });

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-podcast-'));
  const w = (rel, v) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), JSON.stringify(v)); };
  w('role-tracker.json', { 'Citadel|SWE': { stage: 'onsite' }, 'Harvey|Data': { stage: 'applied' }, 'Old|Gone': { stage: 'rejected' } });
  w('role-actions.json', { saved: ['Linear|PE'], skipped: [], applied: [] });
  w('workbooks/citadel-swe/meta.json', { id: 'citadel-swe', roleKeys: ['Citadel|SWE'], status: 'ready' });
  w('workbooks/harvey-data/meta.json', { id: 'harvey-data', roleKeys: ['Harvey|Data'], status: 'ready' });
  w('workbooks/linear-pe/meta.json', { id: 'linear-pe', roleKeys: ['Linear|PE'], status: 'ready' });
  w('interview-work/cheatsheets/citadel-swe/cheatsheet.json', { cards: [card('The six-step coding loop'), card('Order book design', 'design'), card('Kahan summation', 'fundamentals')] });
  w('interview-work/cheatsheets/harvey-data/cheatsheet.json', { cards: [card('Six step coding loop'), card('Merge citation spans', 'algorithms')] });
  w('interview-work/sessions/2026-10-09_1259/analysis.json', { asked: [{ title: 'Event log', rubric: 'Lock the rule.' }], weakSpots: [{ label: 'Counting rule not locked before coding', ref: 0 }] });
  w('trainer/config.json', { phone: '' });
  return d;
}

test('master merges shared cards across companies and ranks onsite first', () => {
  const d = fixture();
  const m = buildMaster(d);
  const loop = m.cards.find((c) => /coding loop/i.test(c.title));
  assert.deepStrictEqual(loop.companies.sort(), ['Citadel', 'Harvey']);
  assert.ok(loop.shared);
  assert.strictEqual(m.cards[0].id, loop.id);
  assert.strictEqual(m.cards.length, 4);
  assert.deepStrictEqual(missingSheets(d).map((r) => r.roleKey), ['Linear|PE']);
  assert.ok(!m.sources.some((s) => s.company === 'Old'));
});

test('agent concept groups merge differently worded cards; bad groups are rejected', async () => {
  const d = fixture();
  const { buildGroups, validateGroups } = require('../lib/podcast/groups');
  const { rawCards } = require('../lib/podcast/master');
  const cards = rawCards(d).cards;
  const kahan = cards.find((c) => c.title === 'Kahan summation').key;
  const spans = cards.find((c) => c.title === 'Merge citation spans').key;
  assert.ok(!validateGroups([{ title: 'x', members: [kahan, 'nope'] }], cards.map((c) => c.key)).ok);
  const runAgentFn = async ({ cwd, prompt }) => {
    assert.match(prompt, /Kahan summation/);
    fs.writeFileSync(path.join(cwd, 'groups.out.json'), JSON.stringify([{ title: 'Numeric care', members: [kahan, spans] }]));
    return { ok: true };
  };
  assert.ok((await buildGroups({ dataDir: d, cards, runAgentFn })).ok);
  const m = buildMaster(d);
  const merged = m.cards.find((c) => c.title === 'Numeric care');
  assert.deepStrictEqual(merged.companies.sort(), ['Citadel', 'Harvey']);
  assert.ok(m.grouped);
  assert.ok((await buildGroups({ dataDir: d, cards, runAgentFn: async () => { throw new Error('should be cached'); } })).cached);
});

test('picker mixes weak spots and cards and holds back recently aired ones', () => {
  const d = fixture();
  const master = buildMaster(d);
  const p = pickConcepts({ dataDir: d, master, today: '2026-10-15' });
  assert.strictEqual(p.weak.length, 1);
  assert.strictEqual(p.cards.length, 3);
  store.recordAired(d, p.cards.map((c) => c.id), '2026-10-15');
  const next = pickConcepts({ dataDir: d, master, today: '2026-10-16' });
  assert.ok(next.cards.every((c) => !p.cards.some((x) => x.id === c.id)));
  store.markFuzzy(d, p.cards[0].id);
  const again = pickConcepts({ dataDir: d, master, today: '2026-10-16' });
  assert.strictEqual(again.cards[0].id, p.cards[0].id);
});

// A script shaped the way episodes must be: every pause follows a question to the listener, lines are full sentences.
function goodScript(words = 1400, { pauses = 7 } = {}) {
  const segs = [];
  const sentence = 'You lock the rule first and then you write the code out loud. ';
  const linesPerPause = Math.max(2, Math.floor(words / 39 / pauses));
  let n = 0, i = 0;
  while (n < words) {
    segs.push({ type: 'line', speaker: HOSTS[i % 2].name, text: sentence.repeat(3).trim() });
    n += 39; i++;
    if (i % linesPerPause === 0) {
      segs.push({ type: 'line', speaker: HOSTS[0].name, text: 'So Tarun, in that room, what is the first thing you say before you touch the keyboard?' });
      segs.push({ type: 'pause', seconds: 6 });
      n += 17;
    }
  }
  return { title: 'Lock the rule', summary: 'Why the rule comes before code.', takeaways: ['a', 'b', 'c'], segments: segs };
}

test('script validation enforces hosts, length and pause beats', () => {
  const ok = validateScript(goodScript(), { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(ok.ok, ok.errors.join('; '));
  const bad = goodScript(300);
  bad.segments = bad.segments.filter((s) => s.type === 'line');
  bad.segments[0].speaker = 'Bob';
  const v = validateScript(bad, { hosts: HOSTS, targetMinutes: 11 });
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => /speaker/.test(e)) && v.errors.some((e) => /words/.test(e)) && v.errors.some((e) => /pause/.test(e)));
  assert.ok(wordTargets(11).minWords > 1000);
});

test('script validation rejects answers-first, clipped commentary and too few think beats', () => {
  const base = () => goodScript(1400, { pauses: 6 });

  // A pause that does not follow a question is the hosts pausing for effect, not the listener thinking.
  const noQuestion = base();
  const firstPause = noQuestion.segments.findIndex((s) => s.type === 'pause');
  noQuestion.segments[firstPause - 1].text = 'Here is the verdict line, word for word. Kahn with a worker pool.';
  let v = validateScript(noQuestion, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /question/.test(e)), v.errors.join('; '));

  // One think beat per concept plus the replay at the end; five concepts need six pauses.
  v = validateScript(goodScript(1400, { pauses: 4 }), { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /pause/.test(e) && /6/.test(e)), v.errors.join('; '));

  // Think beats need real time: 4 seconds or more.
  const short = base();
  short.segments[short.segments.findIndex((s) => s.type === 'pause')].seconds = 2;
  v = validateScript(short, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /4 to 10/.test(e)), v.errors.join('; '));

  // Mostly clipped lines read like sports commentary.
  const clipped = base();
  clipped.segments = clipped.segments.flatMap((s) => (s.type === 'line' && !/\?$/.test(s.text)
    ? Array.from({ length: 6 }, (_, k) => ({ type: 'line', speaker: HOSTS[k % 2].name, text: 'Before your mouth does.' })).concat([s])
    : [s]));
  v = validateScript(clipped, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /commentary|clipped/.test(e)), v.errors.join('; '));

  // The old trivia round is gone.
  const trivia = base();
  trivia.segments[0].text = 'Lightning round. Five fast ones, one sentence each, no pauses.';
  v = validateScript(trivia, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /lightning/i.test(e)), v.errors.join('; '));
});

test('a script the agent finished writing is used even if the agent is cut off afterwards', async () => {
  const d = fixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-script-'));
  const picked = { weak: [], cards: [{ id: 'c1', kind: 'card', title: 'Half-open', category: 'algorithms', bullets: ['Start in, end out.'], companies: ['Harvey'] }], review: [], all: [] };
  picked.all = picked.cards;
  let calls = 0;
  const runAgentFn = async ({ cwd }) => { calls++; fs.writeFileSync(path.join(cwd, 'script.out.json'), JSON.stringify(goodScript())); return { ok: false, timedOut: true, code: null }; };
  const { writeScript } = require('../lib/podcast/script');
  const r = await writeScript({ dataDir: d, workDir: work, picked, config: store.readConfig(d), upcoming: [], runAgentFn });
  assert.ok(r.ok, r.error);
  assert.strictEqual(calls, 1, 'no retry when the file is already valid');
  assert.ok(r.script.segments.length > 10);
});

test('chunking splits at pauses and keeps the pause length', () => {
  const chunks = tts.chunkSegments([
    { type: 'line', speaker: 'Maya', text: 'Question?' }, { type: 'pause', seconds: 5 },
    { type: 'line', speaker: 'Dev', text: 'Answer.' }, { type: 'line', speaker: 'Maya', text: 'Right.' },
  ]);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].pauseAfter, 5);
  assert.strictEqual(chunks[1].lines.length, 2);
  const body = tts.requestBody(chunks[1], { model: 'm', hosts: HOSTS });
  assert.strictEqual(body.input[0].content[0].annotations[0].speaker, 'Dev');
  assert.strictEqual(body.generation_config.speech_config.speakers.length, 2);
});

test('audio extraction strips a WAV header', () => {
  const pcm = Buffer.alloc(100, 1);
  const wav = Buffer.concat([tts.wavHeader(100), pcm]);
  const out = tts.extractAudio({ steps: [{ content: [{ type: 'audio', data: wav.toString('base64') }] }] });
  assert.strictEqual(out.length, 100);
});

const fakeFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ content: [{ type: 'audio', data: Buffer.alloc(24000 * 2).toString('base64') }] }] }) });

test('end to end: episode is written, recorded and fuzzy feedback works', async () => {
  const d = fixture();
  process.env.GEMINI_API_KEY = 'test-key';
  const runAgentFn = async ({ cwd, prompt }) => {
    assert.match(prompt, /Counting rule not locked/);
    assert.match(prompt, /Citadel \(onsite\)/);
    fs.writeFileSync(path.join(cwd, 'script.out.json'), JSON.stringify(goodScript()));
    return { ok: true };
  };
  const ep = await generateEpisode({ dataDir: d, date: '2026-10-15', deliver: false, buildSheets: false, log: () => {}, runAgentFn, fetchFn: fakeFetch, readWorkbook: () => ({ questions: [] }) });
  delete process.env.GEMINI_API_KEY;
  assert.strictEqual(ep.status, 'ready', ep.error);
  assert.ok(fs.existsSync(path.join(store.episodeDir(d, '2026-10-15'), ep.audio)));
  assert.ok(ep.seconds > 5);
  assert.strictEqual(store.listEpisodes(d).length, 1);
  const f = fuzzyFromText(d, 'fuzzy coding loop');
  assert.ok(f.ok, f.message);
  assert.ok(store.readHistory(d)[f.id].fuzzy);
  assert.ok(!fuzzyFromText(d, 'fuzzy').ok);
});

test('missing key fails cleanly', async () => {
  const d = fixture();
  delete process.env.GEMINI_API_KEY;
  const runAgentFn = async ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'script.out.json'), JSON.stringify(goodScript())); return { ok: true }; };
  const ep = await generateEpisode({ dataDir: d, date: '2026-10-15', deliver: false, buildSheets: false, log: () => {}, runAgentFn, fetchFn: fakeFetch, readWorkbook: () => ({ questions: [] }) });
  assert.strictEqual(ep.status, 'failed');
  assert.strictEqual(ep.errorCode, 'no-key');
});
