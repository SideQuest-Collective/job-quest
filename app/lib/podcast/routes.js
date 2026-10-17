// app/lib/podcast/routes.js
const path = require('path');
const store = require('./store');
const episode = require('./episode');
const custom = require('./custom');
const { fuzzyFromText } = require('./fuzzy');
const { activeRoles, missingSheets, rawCards } = require('./master');
const { createPodcastSchedule } = require('./schedule');
const topics = require('./topics');
const { verifyApiKey } = require('./verify');

function registerPodcastRoutes(app, { dataDir, binDir, schedule = createPodcastSchedule({ binDir }), fetchFn }) {
  let running = null;
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  };
  const readTrainerPhone = () => !!store.readJson(path.join(dataDir, 'trainer', 'config.json'), {}).phone;

  // Prove the saved key can record audio (one short line) and remember the verdict for the dashboard.
  const checkKey = async () => {
    const apiKey = store.readApiKey(dataDir);
    const config = store.readConfig(dataDir);
    const r = await verifyApiKey({ apiKey, model: config.model, hosts: config.hosts, ...(fetchFn ? { fetchFn } : {}) });
    return apiKey ? store.writeKeyStatus(dataDir, apiKey, r) : r;
  };

  app.get('/api/podcast', wrap(async () => {
    const master = store.readJson(episode.masterFile(dataDir), null);
    return {
      config: store.readConfig(dataDir),
      hasKey: !!store.readApiKey(dataDir),
      key: store.readKeyStatus(dataDir),
      schedule: await schedule.status(),
      running: !!running,
      episodes: store.listEpisodes(dataDir).slice(0, 30),
      master: master ? { builtAt: master.builtAt, cards: master.cards.length, shared: master.cards.filter((c) => c.shared).length, sources: master.sources, missing: master.missing } : null,
    };
  }));

  // Everything the first-run wizard needs in one call, plus whether to open it automatically.
  app.get('/api/podcast/onboarding', wrap(async () => {
    const hasKey = !!store.readApiKey(dataDir);
    const key = store.readKeyStatus(dataDir);
    const sched = await schedule.status();
    const state = store.readOnboarding(dataDir);
    const roles = activeRoles(dataDir);
    return {
      show: store.shouldShowOnboarding(state, { configured: key.verified && sched.installed }),
      state,
      hasKey,
      key,
      schedule: sched,
      imessageAvailable: readTrainerPhone(),
      config: store.readConfig(dataDir),
      content: { roles: roles.length, sheets: new Set(rawCards(dataDir).cards.map((c) => c.roleKey)).size, missingSheets: missingSheets(dataDir).length },
    };
  }));

  app.post('/api/podcast/onboarding', wrap((req) => ({ state: store.writeOnboarding(dataDir, (req.body || {}).action) })));

  app.put('/api/podcast/schedule', wrap(async (req) => {
    const body = req.body || {};
    const sched = body.enabled === false ? await schedule.uninstall() : await schedule.install(body.time || '08:30');
    if (sched.time) {
      const [hour, minute] = sched.time.split(':').map(Number);
      store.writeConfig(dataDir, { hour, minute });
    }
    return { schedule: sched };
  }));

  app.get('/api/podcast/master', wrap(() => episode.readMaster(dataDir)));

  // Ranked topics the upcoming interviews are likely to ask, with their concept sheets where built.
  app.get('/api/podcast/topics', wrap(() => {
    const ranking = topics.readRanking(dataDir) || topics.rankTopics(dataDir);
    const sheets = new Map(topics.readTopicSheets(dataDir, ranking).map((t) => [t.id, t]));
    return {
      builtAt: ranking.builtAt,
      topics: ranking.topics.map(({ chapters, questions, ...t }) => ({ ...t, questions: questions.slice(0, 6).map((q) => ({ prompt: q.prompt, type: q.type })), sheet: sheets.has(t.id) ? { cards: sheets.get(t.id).cards, builtAt: sheets.get(t.id).sheetBuiltAt, stale: sheets.get(t.id).stale } : null })),
    };
  }));
  app.post('/api/podcast/topics/refresh', wrap(() => { const r = topics.rankTopics(dataDir); return { topics: r.topics.length, missingSheets: topics.missingTopicSheets(dataDir, r).length }; }));
  app.post('/api/podcast/master/refresh', wrap(() => { const m = episode.refreshMaster(dataDir); return { cards: m.cards.length }; }));

  app.get('/api/podcast/episodes/:date/script', wrap((req) => store.readJson(path.join(store.episodeDir(dataDir, req.params.date), 'script.json'), null)));

  app.get('/api/podcast/episodes/:date/audio', (req, res) => {
    try {
      const ep = store.readJson(path.join(store.episodeDir(dataDir, req.params.date), 'episode.json'), null);
      if (!ep || !ep.audio) return res.status(404).json({ error: 'No audio for that day.' });
      // dotfiles: 'allow' because the data directory itself lives under ~/.job-quest, which Express would otherwise hide.
      res.sendFile(path.join(store.episodeDir(dataDir, req.params.date), path.basename(ep.audio)), { dotfiles: 'allow' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/podcast/key/verify', wrap(async () => ({ key: await checkKey() })));

  app.delete('/api/podcast/key', wrap(() => {
    if (store.keySource(dataDir) === 'env') {
      throw Object.assign(new Error('This key comes from the GEMINI_API_KEY environment variable, so it cannot be removed here. Unset that variable and restart the dashboard.'), { status: 409 });
    }
    store.removeApiKey(dataDir);
    return { hasKey: !!store.readApiKey(dataDir), key: store.readKeyStatus(dataDir) };
  }));

  app.post('/api/podcast/generate', wrap(async (req) => {
    if (running) return { started: false, running: true };
    // Never start the (slow, paid) agent work with a key that cannot record the result.
    let key = store.readKeyStatus(dataDir);
    if (!key.verified && key.code === 'unchecked') key = await checkKey();
    if (!key.verified) throw Object.assign(new Error(`${key.message} ${key.remediation}`.trim()), { status: 409 });
    const body = req.body || {};
    running = episode.generateEpisode({ dataDir, force: !!body.force, deliver: !!body.deliver, buildSheets: body.buildSheets !== false, log: (m) => console.log(`[Daily Drop] ${m}`) })
      .finally(() => { running = null; });
    return { started: true };
  }));

  // Record episodes from script files that are already written: { scriptPath } or { scriptPaths: [...] }, optional ids, deliver.
  // Every script is checked before any audio is recorded, then they render one after another in the background.
  app.post('/api/podcast/render', wrap(async (req) => {
    if (running) return { started: false, running: true };
    const body = req.body || {};
    const paths = Array.isArray(body.scriptPaths) ? body.scriptPaths : (body.scriptPath ? [body.scriptPath] : []);
    if (!paths.length) throw Object.assign(new Error('scriptPath or scriptPaths is required'), { status: 400 });
    if (paths.length > 10) throw Object.assign(new Error('at most 10 scripts per request'), { status: 400 });
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    const prepared = [];
    for (let i = 0; i < paths.length; i++) {
      const p = custom.prepareCustomEpisode({ dataDir, scriptPath: paths[i], id: ids[i] });
      if (prepared.some((q) => q.id === p.id)) throw Object.assign(new Error(`two scripts map to the same episode id ${p.id}`), { status: 400 });
      prepared.push(p);
    }
    let key = store.readKeyStatus(dataDir);
    if (!key.verified && key.code === 'unchecked') key = await checkKey();
    if (!key.verified) throw Object.assign(new Error(`${key.message} ${key.remediation}`.trim()), { status: 409 });
    const log = (m) => console.log(`[Daily Drop] ${m}`);
    running = (async () => {
      for (const p of prepared) await custom.renderCustomEpisode({ dataDir, prepared: p, deliver: !!body.deliver, ...(fetchFn ? { fetchFn } : {}), log });
    })().finally(() => { running = null; });
    const seconds = prepared.reduce((n, p) => n + Math.round(p.words / 155 * 60) + p.script.segments.filter((s) => s.type === 'pause').reduce((a, s) => a + s.seconds, 0), 0);
    return { started: true, episodes: prepared.map((p) => ({ id: p.id, title: p.script.title, words: p.words })), estimatedAudioSeconds: seconds };
  }));

  app.put('/api/podcast/config', wrap(async (req) => {
    const body = req.body || {};
    const config = store.writeConfig(dataDir, body);
    let key = null;
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      store.writeApiKey(dataDir, body.apiKey);
      key = await checkKey();
    }
    return { config, hasKey: !!store.readApiKey(dataDir), key: key || store.readKeyStatus(dataDir) };
  }));

  app.post('/api/podcast/fuzzy', wrap((req) => {
    const body = req.body || {};
    if (body.id) { store.markFuzzy(dataDir, String(body.id)); return { ok: true }; }
    return fuzzyFromText(dataDir, body.text);
  }));
}

module.exports = { registerPodcastRoutes };
