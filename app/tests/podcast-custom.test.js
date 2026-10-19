const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/podcast/store');
const custom = require('../lib/podcast/custom');

const fakeFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ content: [{ type: 'audio', data: Buffer.alloc(24000 * 2).toString('base64') }] }] }) });
const line = (speaker, text) => ({ type: 'line', speaker, text });
function script(over = {}) {
  const segments = [];
  for (let i = 0; i < 6; i++) {
    segments.push(line('Dev', `Question number ${i} for the listener, what would you say about this concept right now?`));
    segments.push({ type: 'pause', seconds: 6 });
    segments.push(line('Maya', `Here is the reasoning for question ${i}, explained in plain full sentences so it reads naturally.`));
  }
  return { title: 'Mercor final, part 1', summary: 'A test episode.', takeaways: ['One.'], segments, ...over };
}
function fixture(data = script()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-custom-'));
  const dataDir = path.join(home, '.job-quest', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(home, 'scripts', 'ep1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return { home, dataDir, file };
}

test('episode ids accept a date or a date plus slug', () => {
  assert.ok(store.EPISODE_ID.test('2026-10-17'));
  assert.ok(store.EPISODE_ID.test('2026-10-17-mercor-1'));
  assert.ok(!store.EPISODE_ID.test('2026-10-17-../x'));
  assert.ok(!store.EPISODE_ID.test('../../etc'));
  assert.throws(() => store.episodeDir('/tmp', '2026-10-17-Bad Id'), /invalid episode id/);
});

test('resolveScriptPath only allows .json files inside home', () => {
  const { home, file } = fixture();
  assert.equal(custom.resolveScriptPath(file, { home }), fs.realpathSync(file));
  assert.equal(custom.resolveScriptPath('~/scripts/ep1.json', { home }), fs.realpathSync(file));
  assert.throws(() => custom.resolveScriptPath('scripts/ep1.json', { home }), /absolute/);
  assert.throws(() => custom.resolveScriptPath(path.join(home, 'nope.json'), { home }), /not found/);
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jq-out-')), 'x.json');
  fs.writeFileSync(outside, '{}');
  assert.throws(() => custom.resolveScriptPath(outside, { home }), /inside your home/);
  const txt = path.join(home, 'a.txt'); fs.writeFileSync(txt, '{}');
  assert.throws(() => custom.resolveScriptPath(txt, { home }), /\.json/);
});

test('prepare rejects an invalid script before any audio is made', () => {
  const bad = script(); bad.segments[1] = { type: 'pause', seconds: 6 }; bad.segments[0] = line('Dev', 'This line has no question mark at the end of it at all.');
  const { home, dataDir, file } = fixture(bad);
  assert.throws(() => custom.prepareCustomEpisode({ dataDir, scriptPath: file, home }), /a pause must follow a question/);
  const { home: h2, dataDir: d2, file: f2 } = fixture(script({ segments: [line('Bob', 'Hello there, this speaker is unknown to the app config.')] }));
  assert.throws(() => custom.prepareCustomEpisode({ dataDir: d2, scriptPath: f2, home: h2 }), /script is invalid/);
});

test('prepare derives an id from the title and avoids collisions', () => {
  const { home, dataDir, file } = fixture();
  const p = custom.prepareCustomEpisode({ dataDir, scriptPath: file, home });
  assert.match(p.id, /^\d{4}-\d{2}-\d{2}-mercor-final-part-1$/);
  fs.mkdirSync(store.episodeDir(dataDir, p.id), { recursive: true });
  assert.match(custom.prepareCustomEpisode({ dataDir, scriptPath: file, home }).id, /-mercor-final-part-1-2$/);
  assert.match(custom.prepareCustomEpisode({ dataDir, scriptPath: file, home, id: 'Mercor 2' }).id, /^\d{4}-\d{2}-\d{2}-mercor-2$/);
});

test('renderCustomEpisode records audio and the episode lists with its id', async () => {
  const { home, dataDir, file } = fixture();
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const prepared = custom.prepareCustomEpisode({ dataDir, scriptPath: file, home, id: 'mercor-1' });
    const ep = await custom.renderCustomEpisode({ dataDir, prepared, fetchFn: fakeFetch, log: () => {} });
    assert.equal(ep.status, 'ready');
    assert.equal(ep.source, 'script');
    assert.ok(fs.existsSync(path.join(store.episodeDir(dataDir, prepared.id), ep.audio)));
    assert.deepEqual(store.readJson(path.join(store.episodeDir(dataDir, prepared.id), 'script.json'), null).title, 'Mercor final, part 1');
    const listed = store.listEpisodes(dataDir);
    assert.equal(listed[0].id, prepared.id);
    assert.match(listed[0].date, /^\d{4}-\d{2}-\d{2}$/);
  } finally { delete process.env.GEMINI_API_KEY; }
});

test('renderCustomEpisode marks the episode failed when there is no key', async () => {
  const { home, dataDir, file } = fixture();
  const prepared = custom.prepareCustomEpisode({ dataDir, scriptPath: file, home, id: 'nokey' });
  const ep = await custom.renderCustomEpisode({ dataDir, prepared, fetchFn: fakeFetch, log: () => {} });
  assert.equal(ep.status, 'failed');
  assert.match(ep.error, /No Gemini API key/);
});
