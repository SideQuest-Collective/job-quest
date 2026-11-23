// app/lib/jobs/role-history.js
// The handled-roles ledger (role-history.json): every skip, save, apply or tracking decision,
// append-only. An undone Discover action is marked undone, never deleted. Discover and the daily
// runner treat every active entry as handled, so removing a role from Saved never makes it new.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const identity = require('./role-identity');

const HISTORY_FILE = 'role-history.json';
const HANDLED_ACTIONS = new Set(['skip', 'save', 'apply', 'track']);
const UNDOABLE_ACTIONS = new Set(['skip', 'save', 'apply']);
const historyPath = dataDir => path.join(dataDir, HISTORY_FILE);

function readHistory(dataDir) {
  let text;
  try { text = fs.readFileSync(historyPath(dataDir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || !Array.isArray(value.events)) {
    const error = Error('role-history.json is not a valid ledger.'); error.status = 503; throw error;
  }
  return value;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Newest URL recorded in Intel for each exact Company|Title key.
function intelUrlIndex(dataDir) {
  const dir = path.join(dataDir, 'intel');
  const urls = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().reverse(); } catch { return urls; }
  for (const name of files) {
    const report = readJson(path.join(dir, name), null);
    for (const role of report?.roles || []) {
      const key = identity.roleKeyOf(role);
      if (role?.url && !urls.has(key)) urls.set(key, role.url);
    }
  }
  return urls;
}

function makeEvent({ key, action, source, at, url, company, title, ...rest }) {
  const split = identity.splitKey(key);
  return {
    id: randomUUID(), key, company: company ?? split.company, title: title ?? split.title,
    url: url ? identity.canonicalPostingUrl(url) || url : null, action, source, at, ...rest,
  };
}

function firstTimelineDate(entry) {
  const dates = (Array.isArray(entry?.timeline) ? entry.timeline : []).map(item => item?.date).filter(date => typeof date === 'string').sort();
  return dates[0] || null;
}

// Seed from current saved/skipped/applied, every tracker key, and archived role-action files.
function buildSeed(dataDir, actions, tracker, now) {
  const urls = intelUrlIndex(dataDir);
  const events = [], seen = new Set(), sources = [];
  const add = (key, action, seedSource, at) => {
    if (typeof key !== 'string' || !key.includes('|') || seen.has(`${action}|${key}`)) return;
    seen.add(`${action}|${key}`);
    events.push(makeEvent({ key, action, source: 'seed', seedSource, at: at || now, url: urls.get(key) || tracker?.[key]?.url || null }));
  };
  let archived = [];
  try { archived = fs.readdirSync(dataDir).filter(name => /^role-actions-archived-.*\.json$/.test(name)).sort(); } catch { /* none */ }
  for (const name of archived) {
    const value = readJson(path.join(dataDir, name), null);
    if (!value) continue;
    sources.push(name);
    for (const key of value.saved || []) add(key, 'save', name, value.archivedAt);
    for (const key of value.skipped || []) add(key, 'skip', name, value.archivedAt);
    for (const key of value.applied || []) add(key, 'apply', name, value.archivedAt);
  }
  sources.push('role-actions.json', 'role-tracker.json');
  for (const key of actions.saved || []) add(key, 'save', 'role-actions.json');
  for (const key of actions.skipped || []) add(key, 'skip', 'role-actions.json');
  for (const key of actions.applied || []) add(key, 'apply', 'role-actions.json');
  for (const [key, entry] of Object.entries(tracker || {})) {
    const applied = entry?.stage === 'applied' || entry?.applicationSubmitted === true;
    add(key, applied ? 'apply' : 'track', 'role-tracker.json', firstTimelineDate(entry));
  }
  return { version: 1, seededAt: now, seededFrom: sources, events };
}

// Events for keys that became saved/skipped/applied/tracked between two snapshots.
function diffEvents(prev, prevTracker, next, nextTracker, appliedBefore, appliedAfter, { source, now, urls }) {
  const events = [];
  const fresh = (before, after) => (after || []).filter(key => !(before || []).includes(key));
  const push = (key, action) => events.push(makeEvent({ key, action, source, at: now, url: urls?.get(key) || nextTracker?.[key]?.url || null }));
  fresh(prev.saved, next.saved).forEach(key => push(key, 'save'));
  fresh(prev.skipped, next.skipped).forEach(key => push(key, 'skip'));
  fresh(appliedBefore, appliedAfter).forEach(key => push(key, 'apply'));
  Object.keys(nextTracker || {}).filter(key => !(prevTracker || {})[key] && !appliedAfter.includes(key)).forEach(key => push(key, 'track'));
  return events;
}

const activeHandled = history => (history?.events || []).filter(event => HANDLED_ACTIONS.has(event.action) && !event.undoneAt);

function lastUndoable(history) {
  const events = history?.events || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.source === 'discover' && UNDOABLE_ACTIONS.has(event.action) && !event.undoneAt) return event;
  }
  return null;
}

const publicEvent = event => event && ({ id: event.id, key: event.key, company: event.company, title: event.title, url: event.url, action: event.action, at: event.at });

function summarize(history) {
  return {
    handled: activeHandled(history).map(event => ({ key: event.key, company: event.company, title: event.title, url: event.url, action: event.action, at: event.at })),
    undo: publicEvent(lastUndoable(history)),
    seededAt: history?.seededAt || null,
  };
}

// Every role the user has handled: active ledger entries plus current saved/skipped/applied/tracker keys.
function handledEntries(history, actions, tracker) {
  const entries = activeHandled(history).map(event => ({ key: event.key, company: event.company, title: event.title, url: event.url, action: event.action }));
  for (const key of [...(actions?.saved || []), ...(actions?.skipped || []), ...(actions?.applied || []), ...Object.keys(tracker || {})]) {
    const { company, title } = identity.splitKey(key);
    entries.push({ key, company, title, url: tracker?.[key]?.url || null, action: 'current' });
  }
  return entries;
}

module.exports = { HISTORY_FILE, historyPath, readHistory, buildSeed, diffEvents, makeEvent, activeHandled, lastUndoable, publicEvent, summarize, handledEntries, intelUrlIndex };
