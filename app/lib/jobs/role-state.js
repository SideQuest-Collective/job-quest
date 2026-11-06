const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../interview/atomic');
const roleHistory = require('./role-history');

const emptyActions = () => ({ saved: [], skipped: [], applied: [] });
const unique = values => [...new Set(values)];
function validateActions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ['saved', 'skipped', 'applied'].some(key => !Array.isArray(value[key]) || value[key].some(role => typeof role !== 'string' || !role.trim() || role.length > 500))) {
    const error = Error('Role actions require saved, skipped and applied role-key lists.'); error.status = 400; throw error;
  }
  return { ...value, saved: unique(value.saved), skipped: unique(value.skipped), applied: unique(value.applied) };
}
function readRoleActions(dataDir) {
  try { return validateActions(JSON.parse(fs.readFileSync(path.join(dataDir, 'role-actions.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return emptyActions(); throw error; }
}
function applicationKeys(actions, tracker) {
  return unique([...(actions.applied || []), ...Object.keys(tracker || {}).filter(key => tracker[key]?.stage === 'applied' || tracker[key]?.applicationSubmitted === true)]);
}
function actionsWithApplications(actions, tracker) {
  return { ...actions, applied: applicationKeys(actions, tracker) };
}
function reconcileRoleActions(previous, requested, tracker, now) {
  const body = validateActions(requested);
  const actions = { ...previous, ...body, applied: unique([...applicationKeys(previous, tracker), ...body.applied]) };
  const nextTracker = { ...tracker };
  for (const key of body.applied) {
    const current = tracker[key];
    if (!current || ['discovered', 'researching', 'saved'].includes(current.stage)) {
      nextTracker[key] = { ...(current || { notes: '', checklist: [], timeline: [] }), stage: 'applied', applicationSubmitted: true };
      const previouslyApplied = applicationKeys(previous, tracker).includes(key);
      nextTracker[key].timeline = [...(Array.isArray(current?.timeline) ? current.timeline : []), { date: now, event: previouslyApplied ? 'Application status reconciled' : 'Application submitted (reported by you)' }];
    } else if (current.applicationSubmitted !== true) nextTracker[key] = { ...current, applicationSubmitted: true };
  }
  return { actions, tracker: nextTracker };
}
// Publishes tracker, actions and (when given) the handled-roles ledger together; any failure restores all.
function writeRoleState(dataDir, actions, tracker, history) {
  const files = [path.join(dataDir, 'role-tracker.json'), path.join(dataDir, 'role-actions.json')];
  const bodies = [JSON.stringify(tracker, null, 2), JSON.stringify(actions, null, 2)];
  if (history) { files.push(roleHistory.historyPath(dataDir)); bodies.push(JSON.stringify(history, null, 2)); }
  const before = files.map(file => { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } });
  try {
    files.forEach((file, i) => writeFileAtomic(file, bodies[i]));
  } catch (error) {
    for (let i = 0; i < files.length; i++) {
      try { if (before[i] === null) { if (fs.existsSync(files[i])) fs.unlinkSync(files[i]); } else writeFileAtomic(files[i], before[i]); }
      catch (restoreError) { error.restoreError = restoreError; }
    }
    throw error;
  }
}

// Creates role-history.json from existing decisions the first time it is needed. Existing data files are only read.
function ensureRoleHistory(dataDir, actions, tracker, now) {
  const existing = roleHistory.readHistory(dataDir);
  if (existing) return existing;
  const seeded = roleHistory.buildSeed(dataDir, actions, tracker, now);
  writeFileAtomic(roleHistory.historyPath(dataDir), JSON.stringify(seeded, null, 2));
  return seeded;
}

// Ledger entries for keys a legacy full-state write newly saved/skipped/applied/tracked.
// Returns undefined (nothing to publish) until the ledger exists; the seed captures earlier state.
function recordRoleHistory(dataDir, prev, prevTracker, next, nextTracker, now, source) {
  const history = roleHistory.readHistory(dataDir);
  if (!history) return undefined;
  const events = roleHistory.diffEvents(prev, prevTracker, next, nextTracker, applicationKeys(prev, prevTracker), applicationKeys(next, nextTracker),
    { source, now, urls: roleHistory.intelUrlIndex(dataDir) });
  if (!events.length) return undefined;
  return { ...history, events: [...history.events, ...events] };
}

const ROLE_EVENT_ACTIONS = ['skip', 'save', 'apply', 'undo'];
const conflict = (message, status = 409) => { const error = Error(message); error.status = status; return error; };
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// One Discover decision for one role, applied to the files as they are now (never a client snapshot).
function applyRoleEvent(dataDir, body, tracker, now) {
  const action = body?.action;
  if (!ROLE_EVENT_ACTIONS.includes(action)) throw conflict('Role event action must be skip, save, apply or undo.', 400);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (action !== 'undo' && (!key || !key.includes('|') || key.length > 500)) throw conflict('Role event requires a Company|Title key.', 400);
  const url = typeof body.url === 'string' && body.url.length <= 2000 ? body.url : null;
  const aliases = Array.isArray(body.keys) ? [...new Set(body.keys.filter(k => typeof k === 'string' && k.includes('|') && k.length <= 500 && k !== key))].slice(0, 20) : [];
  const prev = readRoleActions(dataDir);
  const history = ensureRoleHistory(dataDir, prev, tracker, now);
  const events = history.events.map(event => ({ ...event }));
  const appliedBefore = applicationKeys(prev, tracker);
  let actions = prev, nextTracker = tracker, event, undone = null;

  if (action === 'undo') {
    const target = body.eventId ? events.find(item => item.id === body.eventId) : roleHistory.lastUndoable({ events });
    const latest = roleHistory.lastUndoable({ events });
    if (!target || !latest) throw conflict('Nothing to undo.');
    if (target.id !== latest.id || target.undoneAt) throw conflict('Only the most recent Discover action can be undone. Refresh and retry.');
    if (key && key !== target.key) throw conflict('That action was already undone or replaced. Refresh and retry.');
    const at = events.indexOf(target);
    if (events.slice(at + 1).some(item => item.key === target.key && !item.undoneAt && item.action !== 'undo')) throw conflict('This role changed after that action. Update it in Intel instead.');
    const prior = target.prior || {};
    if (target.action === 'apply' && !sameJson(tracker[target.key], target.afterTracker)) throw conflict('The application status changed since. Update it in Intel instead.');
    const restore = (list, wanted) => {
      const has = (actions[list] || []).includes(target.key);
      if (wanted && !has) return [...actions[list], target.key];
      if (!wanted && has) return actions[list].filter(k => k !== target.key);
      return actions[list];
    };
    actions = { ...prev };
    actions.saved = restore('saved', prior.saved === true);
    actions.skipped = restore('skipped', prior.skipped === true);
    actions.applied = restore('applied', prior.appliedListed === true);
    if (target.action === 'apply') {
      nextTracker = { ...tracker };
      if (prior.tracker == null) delete nextTracker[target.key]; else nextTracker[target.key] = prior.tracker;
    }
    target.undoneAt = now;
    undone = target;
    event = roleHistory.makeEvent({ key: target.key, company: target.company, title: target.title, url: target.url, action: 'undo', source: 'discover', at: now, undoes: target.id });
  } else {
    const prior = { saved: prev.saved.includes(key), skipped: prev.skipped.includes(key), appliedListed: prev.applied.includes(key), applied: appliedBefore.includes(key) };
    if ((action === 'skip' && prior.skipped) || (action === 'save' && prior.saved) || (action === 'apply' && prior.applied)) {
      return { duplicate: true, actions: prev, tracker, history, event: null, undone: null, prev, prevTracker: tracker };
    }
    if (action === 'skip') actions = { ...prev, skipped: [...prev.skipped, key] };
    else if (action === 'save') actions = { ...prev, saved: [...prev.saved, key] };
    else {
      const next = reconcileRoleActions(prev, { ...prev, applied: [...prev.applied, key], saved: prev.saved.filter(k => k !== key) }, tracker, now);
      actions = next.actions; nextTracker = next.tracker;
      prior.tracker = tracker[key] ?? null;
    }
    event = roleHistory.makeEvent({ key, action, source: 'discover', at: now, url, aliases, prior, ...(action === 'apply' ? { afterTracker: nextTracker[key] ?? null } : {}) });
  }
  const nextHistory = { ...history, events: [...events, event] };
  writeRoleState(dataDir, actions, nextTracker, nextHistory);
  return { duplicate: false, actions, tracker: nextTracker, history: nextHistory, event, undone, prev, prevTracker: tracker };
}
module.exports = { validateActions, readRoleActions, applicationKeys, actionsWithApplications, reconcileRoleActions, writeRoleState, ensureRoleHistory, recordRoleHistory, applyRoleEvent };
