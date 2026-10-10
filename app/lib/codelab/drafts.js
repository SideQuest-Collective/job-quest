const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../interview/atomic');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
function fail(message, status = 400, current) { throw Object.assign(new Error(message), { status, current }); }
function readProgress(dataDir) {
  const file = path.join(dataDir, 'problems', 'progress.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { solved: {}, bookmarked: [], savedCode: {}, draftRevisions: {} };
    fail('Saved Code Lab progress could not be read. Existing data was preserved.', 500);
  }
  if (!isObject(state) || (state.savedCode !== undefined && !isObject(state.savedCode)) || (state.draftRevisions !== undefined && !isObject(state.draftRevisions))) fail('Saved Code Lab progress has an unsupported format. Existing data was preserved.', 500);
  return state;
}
function saveDraft({ dataDir, getProblems }, id, body) {
  if (!validId(id)) fail('Invalid problem id');
  if (!isObject(body) || Object.keys(body).some(key => !['code', 'expectedRevision'].includes(key))) fail('Send code and expectedRevision only');
  if (typeof body.code !== 'string' || body.code.length > 1000000) fail('Code must be text of at most 1,000,000 characters');
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) fail('A nonnegative expectedRevision is required');
  const problems = getProblems();
  if (!problems || !Array.isArray(problems.problems)) fail('The problem list could not be read. Your draft was not changed.', 500);
  if (!problems.problems.some(problem => problem && problem.id === id)) fail('This problem no longer exists. Keep your draft and reload the problem list.', 404);
  // The read/compare/write is synchronous within the dashboard process, so two
  // devices cannot both overwrite this problem from the same revision.
  const state = readProgress(dataDir);
  const codes = state.savedCode || {}, revisions = state.draftRevisions || {};
  const code = Object.hasOwn(codes, id) ? codes[id] : '';
  const revision = Object.hasOwn(revisions, id) ? revisions[id] : 0;
  if (typeof code !== 'string' || !Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) fail('This saved draft has an unsupported format. Existing data was preserved.', 500);
  const current = { code, revision };
  if (body.expectedRevision !== revision) fail('This code changed on another device. Compare the saved version before replacing it.', 409, current);
  const next = { code: body.code, revision: revision + 1 };
  const updated = { ...state, savedCode: { ...codes, [id]: next.code }, draftRevisions: { ...revisions, [id]: next.revision } };
  writeFileAtomic(path.join(dataDir, 'problems', 'progress.json'), JSON.stringify(updated, null, 2));
  return next;
}
function registerDraftRoutes(app, options) {
  app.patch('/api/problems/:id/draft', (req, res) => {
    try { res.json(saveDraft(options, req.params.id, req.body)); }
    catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save your code. Keep this draft and try again.', ...(error.current ? { ...error.current, current: error.current } : {}) });
    }
  });
}
module.exports = { registerDraftRoutes, saveDraft, readProgress, validId };
