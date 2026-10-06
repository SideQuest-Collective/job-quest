// app/lib/interview/tracker-effects.js
// Deterministic tracker write-back: timeline entry keyed interview:<folder>, stage ladder, recruiter memory.
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { ROUND_LABEL } = require('./workbook-markup');

const ROUND_RANK = { recruiter: 1, screen: 2, coding: 3, system: 3, behavioral: 3 };
const RANK_STAGE = { 1: 'phone-screen', 2: 'phone-screen', 3: 'onsite' };
const STAGE_RANK = { discovered: 0, researching: 0, saved: 0, applied: 0, 'phone-screen': 2, onsite: 3 };

const trackerFile = (dataDir) => path.join(dataDir, 'role-tracker.json');

function readTracker(dataDir) {
  try { return JSON.parse(fs.readFileSync(trackerFile(dataDir), 'utf-8')); } catch (error) {
    if (error.code === 'ENOENT') return {};
    // A failed read of the live tracker must not become an empty write-back.
    throw error;
  }
}

function writeTracker(dataDir, tracker) {
  const file = trackerFile(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(tracker, null, 2));
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function ensureEntry(tracker, roleKey) {
  if (!tracker[roleKey]) tracker[roleKey] = { stage: 'discovered', notes: '', checklist: [], timeline: [] };
  const e = tracker[roleKey];
  if (!Array.isArray(e.timeline)) e.timeline = [];
  return e;
}

function timelineEvent({ round, interviewer, durationMin, practice }) {
  const label = ROUND_LABEL[round] || `${String(round).charAt(0).toUpperCase()}${String(round).slice(1)}`;
  return `${label} round${interviewer ? ` with ${interviewer}` : ''}, ${durationMin} min${practice ? ', practice' : ''}`;
}

function upsertTimeline(entry, { key, date, event }) {
  const i = entry.timeline.findIndex((t) => t && t.key === key);
  const item = { date, event, key };
  if (i >= 0) {
    if (entry.timeline[i].date === date && entry.timeline[i].event === event) return 'same';
    Object.assign(entry.timeline[i], item);
    return 'updated';
  }
  // The dashboard writes UTC ISO timestamps; preserve them (startedAt is ISO too).
  // Legacy YYYY-MM-DD sorts before same-day timestamps and after prior-day ones
  // by code-unit comparison. Keep all dates and existing item order unchanged.
  const at = entry.timeline.findIndex((t) => t && t.date && String(t.date) > String(date));
  if (at === -1) entry.timeline.push(item); else entry.timeline.splice(at, 0, item);
  return 'added';
}

function removeTimeline(entry, key) {
  const before = entry.timeline.length;
  entry.timeline = entry.timeline.filter((t) => !(t && t.key === key));
  return entry.timeline.length !== before;
}

function applyStage(entry, round, practice) {
  if (practice) return null;
  if (!Object.prototype.hasOwnProperty.call(ROUND_RANK, round)) return null;
  const want = ROUND_RANK[round];
  if (!want) return null;
  if (!Object.prototype.hasOwnProperty.call(STAGE_RANK, entry.stage)) return null;
  if (STAGE_RANK[entry.stage] >= want) return null;
  const from = entry.stage;
  entry.stage = RANK_STAGE[want];
  return { from, to: entry.stage };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function upsertRecruiterNotes(entry, folder, date, memory) {
  const lines = [`[interview:${folder}] Recruiter call ${date}`];
  for (const [title, body] of Object.entries(memory)) lines.push(`${title}:`, body);
  lines.push(`[/interview:${folder}]`);
  const block = lines.join('\n');
  const notes = String(entry.notes || '');
  const re = new RegExp(`\\[interview:${escapeRe(folder)}\\][\\s\\S]*?\\[/interview:${escapeRe(folder)}\\]`);
  const next = re.test(notes)
    ? notes.replace(re, () => block)
    : (notes.trim() ? `${notes.replace(/\s+$/, '')}\n\n${block}` : block);
  const changed = next !== notes;
  entry.notes = next;
  return changed;
}

module.exports = {
  ROUND_RANK, STAGE_RANK, readTracker, writeTracker, ensureEntry, timelineEvent,
  upsertTimeline, removeTimeline, applyStage, upsertRecruiterNotes,
};
