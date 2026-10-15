// app/lib/podcast/routes.js
const path = require('path');
const store = require('./store');
const episode = require('./episode');
const { fuzzyFromText } = require('./fuzzy');
const { activeRoles, missingSheets, rawCards } = require('./master');
const { createPodcastSchedule } = require('./schedule');

function registerPodcastRoutes(app, { dataDir, binDir, schedule = createPodcastSchedule({ binDir }) }) {
  let running = null;
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  };
  const readTrainerPhone = () => !!store.readJson(path.join(dataDir, 'trainer', 'config.json'), {}).phone;

  app.get('/api/podcast', wrap(async () => {
    const master = store.readJson(episode.masterFile(dataDir), null);
    return {
      config: store.readConfig(dataDir),
      hasKey: !!store.readApiKey(dataDir),
      schedule: await schedule.status(),
      running: !!running,
      episodes: store.listEpisodes(dataDir).slice(0, 30),
      master: master ? { builtAt: master.builtAt, cards: master.cards.length, shared: master.cards.filter((c) => c.shared).length, sources: master.sources, missing: master.missing } : null,
    };
  }));

  // Everything the first-run wizard needs in one call, plus whether to open it automatically.
  app.get('/api/podcast/onboarding', wrap(async () => {
    const hasKey = !!store.readApiKey(dataDir);
    const sched = await schedule.status();
    const state = store.readOnboarding(dataDir);
    const roles = activeRoles(dataDir);
    return {
      show: store.shouldShowOnboarding(state, { configured: hasKey && sched.installed }),
      state,
      hasKey,
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
  app.post('/api/podcast/master/refresh', wrap(() => { const m = episode.refreshMaster(dataDir); return { cards: m.cards.length }; }));

  app.get('/api/podcast/episodes/:date/script', wrap((req) => store.readJson(path.join(store.episodeDir(dataDir, req.params.date), 'script.json'), null)));

  app.get('/api/podcast/episodes/:date/audio', (req, res) => {
    try {
      const ep = store.readJson(path.join(store.episodeDir(dataDir, req.params.date), 'episode.json'), null);
      if (!ep || !ep.audio) return res.status(404).json({ error: 'No audio for that day.' });
      res.sendFile(path.join(store.episodeDir(dataDir, req.params.date), path.basename(ep.audio)));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/podcast/generate', wrap((req) => {
    if (running) return { started: false, running: true };
    const body = req.body || {};
    running = episode.generateEpisode({ dataDir, force: !!body.force, deliver: !!body.deliver, buildSheets: body.buildSheets !== false, log: (m) => console.log(`[Daily Drop] ${m}`) })
      .finally(() => { running = null; });
    return { started: true };
  }));

  app.put('/api/podcast/config', wrap((req) => {
    const body = req.body || {};
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) store.writeApiKey(dataDir, body.apiKey);
    return { config: store.writeConfig(dataDir, body), hasKey: !!store.readApiKey(dataDir) };
  }));

  app.post('/api/podcast/fuzzy', wrap((req) => {
    const body = req.body || {};
    if (body.id) { store.markFuzzy(dataDir, String(body.id)); return { ok: true }; }
    return fuzzyFromText(dataDir, body.text);
  }));
}

module.exports = { registerPodcastRoutes };
