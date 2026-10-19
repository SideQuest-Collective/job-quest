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
  // Weak spots are opt-in now; this test asks for them to check the mixing and hold-back rules.
  const counts = { weak: 2, cards: 3, review: 1 };
  const p = pickConcepts({ dataDir: d, master, today: '2026-10-15', counts });
  assert.strictEqual(p.weak.length, 1);
  assert.strictEqual(p.cards.length, 3);
  store.recordAired(d, p.cards.map((c) => c.id), '2026-10-15');
  const next = pickConcepts({ dataDir: d, master, today: '2026-10-16', counts });
  assert.ok(next.cards.every((c) => !p.cards.some((x) => x.id === c.id)));
  store.markFuzzy(d, p.cards[0].id);
  const again = pickConcepts({ dataDir: d, master, today: '2026-10-16', counts });
  assert.strictEqual(again.cards[0].id, p.cards[0].id);
});

// A script shaped the way episodes must be: every pause follows a question to the listener, lines are full sentences.
function goodScript(words = 2600, { pauses = 7 } = {}) {
  const segs = [];
  const sentence = 'You lock the rule first and then you write the code out loud. ';
  const linesPerPause = Math.max(2, Math.floor(words / 39 / pauses));
  let n = 0, i = 0;
  while (n < words) {
    segs.push({ type: 'line', speaker: HOSTS[i % 2].name, text: sentence.repeat(3).trim() });
    n += 39; i++;
    // The first question comes right after the opener; later ones are spread evenly.
    if (i === 1 || i % linesPerPause === 0) {
      segs.push({ type: 'line', speaker: HOSTS[0].name, text: 'So Tarun, in that room, what is the first thing you say before you touch the keyboard?' });
      segs.push({ type: 'pause', seconds: 6 });
      n += 17;
    }
  }
  return { title: 'Lock the rule', summary: 'Why the rule comes before code.', takeaways: ['a', 'b', 'c'], segments: segs };
}

test('closed roles leave the podcast: saved-but-rejected roles, their session weak spots and their workbook reviews', () => {
  const d = fixture();
  const w = (rel, v) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), JSON.stringify(v)); };
  // 'Old|Gone' is rejected in the tracker but still sits in the saved list; its interview and workbook must not feed episodes.
  w('role-actions.json', { saved: ['Linear|PE', 'Old|Gone'], skipped: [], applied: ['Old|Gone'] });
  w('interview-work/sessions/2026-10-12_0900_old-onsite/analysis.json', { asked: [{ title: 'Dead question', rubric: 'r' }], weakSpots: [{ label: 'Weak spot from the dead role', ref: 0 }] });
  w('interview-sessions/2026-10-12_0900_old-onsite.json', { folder: '2026-10-12_0900_old-onsite', roleKey: 'Old|Gone', status: 'ingested' });
  w('workbooks/old-gone/meta.json', { id: 'old-gone', roleKeys: ['Old|Gone'], status: 'ready' });
  w('trainer/workbook-srs.json', { 'old-gone:q1': { dueAt: '2026-10-01T00:00:00Z' }, 'citadel-swe:q1': { dueAt: '2026-10-01T00:00:00Z' } });
  const { activeRoles } = require('../lib/podcast/master');
  assert.ok(!activeRoles(d).some((r) => r.roleKey === 'Old|Gone'), 'a rejected role is not revived by the saved or applied lists');

  const readWorkbook = (dir, id) => ({ questions: [{ id: 'q1', prompt: `${id} question?`, answer: 'a', topic: 't' }] });
  const picked = pickConcepts({ dataDir: d, master: buildMaster(d), today: '2026-10-15', now: new Date('2026-10-15T12:00:00Z'), readWorkbook, counts: { weak: 5, cards: 3, review: 3 } });
  assert.ok(!picked.weak.some((x) => /dead role/.test(x.label)), 'weak spots from a closed role are skipped');
  assert.ok(picked.weak.some((x) => /Counting rule/.test(x.label)), 'weak spots from live roles still come through');
  assert.ok(!picked.review.some((x) => x.workbookId === 'old-gone'), 'review questions from a closed role are skipped');
  assert.ok(picked.review.some((x) => x.workbookId === 'citadel-swe'), 'review questions from live roles still come through');
});

test('episodes teach concepts, not interviews: material and script carry no company names or interview framing', () => {
  const { materialText } = require('../lib/podcast/script');
  const picked = {
    weak: [{ id: 'w1', kind: 'weak-spot', date: '2026-10-08', session: 'rippling screen', label: 'Described a lazy search instead of a write-time index', question: { title: 'Keyword search over logged messages', rubric: 'Index at write time.' } }],
    cards: [{ id: 'c1', kind: 'card', title: 'Half-open intervals', category: 'algorithms', bullets: ['Start in, end out.'], companies: ['Rippling', 'Mercor'], shared: true }],
    review: [],
  };
  picked.all = [...picked.weak, ...picked.cards];
  const m = materialText(picked);
  assert.ok(!/Rippling|Mercor|2026-10-08|rippling screen/.test(m), m);
  assert.ok(/Keyword search over logged messages/.test(m) && /Half-open intervals/.test(m), 'the teaching content itself stays');

  const named = goodScript(1400, { pauses: 7 });
  named.segments[0].text = 'Today we cover the loop you will use at Rippling and Mercor, and interviews coming up this week. Here is the first idea for you to think about.';
  const v = validateScript(named, { hosts: HOSTS, targetMinutes: 11, concepts: 5, forbidden: ['Rippling', 'Mercor'] });
  assert.ok(!v.ok && v.errors.some((e) => /Rippling/.test(e)) && v.errors.some((e) => /interviews coming up/i.test(e)), v.errors.join('; '));
  assert.ok(validateScript(goodScript(1400, { pauses: 7 }), { hosts: HOSTS, targetMinutes: 11, concepts: 5, forbidden: ['Rippling'] }).ok);
});

test('script validation enforces hosts, length and pause beats', () => {
  const ok = validateScript(goodScript(1400), { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
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

test('script validation keeps episodes plain: no sponsors, no delivery notes, first question early', () => {
  const base = () => goodScript(1400, { pauses: 7 });

  const ad = base();
  ad.segments[1].text = 'Brought to you by In-Degree Zero, the energy drink that waits for its dependencies.';
  let v = validateScript(ad, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /sponsor|ad/i.test(e)), v.errors.join('; '));

  // Delivery notes get read aloud or mangled by the voice model; they are dropped, never passed through.
  const styled = base();
  styled.segments[0].style = 'quiet, close to the mic';
  v = validateScript(styled, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(v.ok, v.errors.join('; '));
  assert.ok(v.script.segments.every((s) => !('style' in s)), 'style must not survive validation');

  // A long preamble before the first question is an intro, and he asked for none.
  const slow = base();
  const filler = { type: 'line', speaker: HOSTS[1].name, text: 'Welcome back to the show, it is a beautiful morning and we have so much to get through today together. ' };
  slow.segments = Array.from({ length: 20 }, () => filler).concat(slow.segments);
  v = validateScript(slow, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /first question|300 words/i.test(e)), v.errors.join("; "));
});

test('only companies with upcoming rounds are banned from the script; saved roles with ordinary-word names are not', async () => {
  const d = fixture();
  const actions = JSON.parse(fs.readFileSync(path.join(d, 'role-actions.json')));
  actions.saved.push('Circle|Data', 'Linear|PE');
  fs.writeFileSync(path.join(d, 'role-actions.json'), JSON.stringify(actions));
  const { writeScript } = require('../lib/podcast/script');
  const picked = { weak: [], topics: [], cards: [{ id: 'c1', kind: 'card', title: 'Scan', category: 'algorithms', bullets: ['One pass.'], companies: ['Citadel'] }], review: [] };
  picked.all = picked.cards;
  const withLine = (text) => async ({ cwd }) => { const g = goodScript(); g.segments[0].text = text; fs.writeFileSync(path.join(cwd, 'script.out.json'), JSON.stringify(g)); return { ok: true }; };
  const ok = await writeScript({ dataDir: d, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jq-s-')), picked, config: store.readConfig(d), upcoming: [], runAgentFn: withLine('Draw a circle around the linear scan and clear the stack, then sequence the writes via a queue.') });
  assert.ok(ok.ok, ok.error);
  const bad = await writeScript({ dataDir: d, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jq-s-')), picked, config: store.readConfig(d), upcoming: [], runAgentFn: withLine('This is the kind of thing Citadel asks in the onsite.') });
  assert.ok(!bad.ok && /Citadel/.test(bad.error), bad.error);
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
    assert.ok(!/Counting rule not locked/.test(prompt), 'past interview weak spots no longer drive episodes');
    assert.match(prompt, /coding loop|Order book|Kahan|Merge citation/, 'concepts from the study sheets still do');
    assert.ok(!/Citadel|Harvey|Linear/.test(prompt), 'the writer never sees company names in the episode brief');
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

test('iMessage delivery sends the audio the way that reaches the phone: an alias of the file, to the existing chat', () => {
  const { imessageScript } = require('../lib/podcast/episode');
  const s = imessageScript();
  assert.match(s, /as alias/, 'a raw POSIX file sent to a buddy is accepted by Messages but never arrives');
  assert.match(s, /1st chat whose participants contains targetBuddy/);
  assert.match(s, /send theFile to targetChat/);
  assert.match(s, /send theFile to targetBuddy/, 'falls back to the buddy when no chat exists yet');
  assert.ok(s.indexOf('send (item 2 of argv)') < s.indexOf('send theFile'), 'text first, then the audio');
  // Each day gets its own file name so a regenerated episode is not mistaken for one already sent.
  const { sharedAudioName } = require('../lib/podcast/episode');
  assert.notStrictEqual(sharedAudioName({ date: '2026-10-16' }, 'x.mp3', new Date('2026-10-16T10:00:00Z')), sharedAudioName({ date: '2026-10-16' }, 'x.mp3', new Date('2026-10-16T11:00:00Z')));
  assert.match(sharedAudioName({ date: '2026-10-16' }, 'x.mp3', new Date('2026-10-16T10:00:00Z')), /^Daily Drop 2026-10-16 .*\.mp3$/);
});

test('script validation keeps it a conversation: short lines, no long monologues, the learner host speaks', () => {
  const run = goodScript(1400, { pauses: 7 });
  const at = run.segments.findIndex((s, i) => i > 3 && s.type === 'line');
  const maya = { type: 'line', speaker: HOSTS[0].name, text: 'You lock the rule first and then you write the code out loud, one step at a time, slowly.' };
  run.segments.splice(at, 0, maya, maya, maya, maya);
  let v = validateScript(run, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /in a row/.test(e)), v.errors.join('; '));

  const lecture = goodScript(1400, { pauses: 7 });
  lecture.segments.forEach((s, i) => { if (s.type === 'line' && s.speaker === HOSTS[1].name && i % 3) s.speaker = HOSTS[0].name; });
  v = validateScript(lecture, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /quarter of the lines/.test(e)), v.errors.join('; '));

  const long = goodScript(1400, { pauses: 7 });
  long.segments[0].text = 'You lock the rule first and then you write the code out loud. '.repeat(8);
  v = validateScript(long, { hosts: HOSTS, targetMinutes: 11, concepts: 5 });
  assert.ok(!v.ok && v.errors.some((e) => /450/.test(e)), v.errors.join('; '));
});

test('the coding loop and design frame from the shared sheets reach the material; other cards do not', () => {
  const { readFrameworks, materialText } = require('../lib/podcast/script');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-interview-'));
  const dir = path.join(home, 'cheatsheets', 'topics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coding-loop.json'), JSON.stringify({ cards: [{ title: 'Restate in one sentence', category: 'process', bullets: ['Say what I get and what I return.'] }] }));
  fs.writeFileSync(path.join(dir, 'system-design-frame.json'), JSON.stringify({ cards: [
    { title: 'Seven steps in 45 minutes', category: 'frame', bullets: ['Requirements, entities, API, HLD, deep dives.'] },
    { title: 'Columnar store', category: 'blocks', bullets: ['Analytics.'] },
  ] }));
  const f = readFrameworks(home);
  assert.deepStrictEqual(f.map((x) => x.cards.length), [1, 1]);
  const m = materialText({ weak: [], topics: [], cards: [], review: [], frameworks: f });
  assert.match(m, /How to talk a problem through/);
  assert.match(m, /Restate in one sentence/);
  assert.match(m, /Seven steps in 45 minutes/);
  assert.ok(!/Columnar/.test(m));
  assert.deepStrictEqual(readFrameworks(path.join(home, 'missing')), []);
});
