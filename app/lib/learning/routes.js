const store = require('./store');
const { recommendations } = require('./recommendations');
const { readLinkedSources, linkedConflicts } = require('./linked-sources');
function registerLearningRoutes(app, { dataDir, getProblems, interviewHome, getLinkedSources = () => readLinkedSources({ interviewHome }) }) {
  const wrap = (fn) => (req, res) => {
    try { res.json(fn(req)); } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Learning data could not be read or saved. Existing data was preserved.' }); }
  };
  app.get('/api/learning', wrap(() => {
    const next = { ...store.load(dataDir), ...store.quickChoices(dataDir, getProblems), media: store.catalog, importableCount: 0 };
    try { next.importableCount = store.existingReferences(dataDir).length; }
    catch { next.warnings.push('Existing concept references could not be read. Saved learning sessions remain available.'); }
    const linked = getLinkedSources();
    next.linkedSources = linked.sources;
    next.linkedAvailable = linked.available;
    next.linkedWarnings = linked.warnings || [];
    next.linkedConflicts = linkedConflicts(next.sources, linked.sources);
    Object.assign(next, recommendations(dataDir, { choices: next.choices, state: next, linkedSources: linked.sources }));
    return next;
  }));
  app.post('/api/learning/import-existing', wrap((req) => store.importExisting(dataDir, req.body || {})));
  app.post('/api/learning/sources', wrap((req) => store.saveSource(dataDir, req.body || {})));
  app.post('/api/learning/session', wrap((req) => store.saveSession(dataDir, req.body || {}, { getLinkedSources })));
}
module.exports = { registerLearningRoutes };
