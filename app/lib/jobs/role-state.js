const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../interview/atomic');

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
function writeRoleState(dataDir, actions, tracker) {
  const files = [path.join(dataDir, 'role-tracker.json'), path.join(dataDir, 'role-actions.json')];
  const before = files.map(file => { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } });
  try {
    writeFileAtomic(files[0], JSON.stringify(tracker, null, 2));
    writeFileAtomic(files[1], JSON.stringify(actions, null, 2));
  } catch (error) {
    for (let i = 0; i < files.length; i++) {
      try { if (before[i] === null) { if (fs.existsSync(files[i])) fs.unlinkSync(files[i]); } else writeFileAtomic(files[i], before[i]); }
      catch (restoreError) { error.restoreError = restoreError; }
    }
    throw error;
  }
}
module.exports = { validateActions, readRoleActions, applicationKeys, actionsWithApplications, reconcileRoleActions, writeRoleState };
