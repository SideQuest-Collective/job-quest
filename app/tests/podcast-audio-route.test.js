const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const store = require('../lib/podcast/store');
const { registerPodcastRoutes } = require('../lib/podcast/routes');

test('episode audio is served even when the data directory lives under a dot-folder like ~/.job-quest', async (t) => {
  // Real installs keep data in ~/.job-quest/data; Express hides dot-segments by default, which must not hide the episode.
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jq-audio-')), '.job-quest', 'data');
  fs.mkdirSync(d, { recursive: true });
  const dir = store.episodeDir(d, '2026-10-15');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'episode.mp3'), Buffer.from('ID3fake-audio'));
  store.writeJson(path.join(dir, 'episode.json'), { date: '2026-10-15', status: 'ready', audio: 'episode.mp3', seconds: 3 });

  const schedule = { status: async () => ({ installed: false, time: null }), install: async () => ({}), uninstall: async () => ({}) };
  const app = express();
  app.use(express.json());
  registerPodcastRoutes(app, { dataDir: d, schedule, fetchFn: async () => { throw new Error('no network in tests'); } });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/api/podcast/episodes/2026-10-15/audio`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'ID3fake-audio');
  assert.strictEqual((await fetch(`${base}/api/podcast/episodes/2026-10-14/audio`)).status, 404, 'a day without an episode is still a 404');
});
