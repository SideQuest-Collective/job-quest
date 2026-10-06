// app/lib/interview/session-parse.js
// Parse one /interview session folder (contract: outbound). Markdown sections are optional.
const fs = require('fs');
const path = require('path');
const { assertContract, NotFoundError, InputError, PLACEHOLDER } = require('./contract');

const MEMORY_SECTIONS = ['About the role', 'Facts they said', 'Things they want to hear', 'Answers I gave', 'Questions still open'];

function readText(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

function extractSection(md, title) {
  const lines = String(md || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === PLACEHOLDER || body === '_none recorded_' ? '' : body;
}

function parseInterviewer(md) {
  const m = /^Interviewer:\s*(\p{Lu}[\p{L}'’-]*)/mu.exec(extractSection(md, 'Scorecard'));
  return m ? m[1] : null;
}

function parseTotalSeconds(md) {
  const m = /Total session:\s*(\d+):(\d{2})/.exec(String(md || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function phaseMinutes(history, endSec) {
  const order = [];
  const secs = new Map();
  for (const h of history || []) {
    if (!h || typeof h.phase !== 'string' || typeof h.start !== 'number') continue;
    const end = typeof h.end === 'number' ? h.end : (endSec != null ? endSec : h.start);
    if (!secs.has(h.phase)) { order.push(h.phase); secs.set(h.phase, 0); }
    secs.set(h.phase, secs.get(h.phase) + Math.max(0, end - h.start));
  }
  return order.map((phase) => ({ phase, minutes: Math.round((secs.get(phase) / 60) * 10) / 10 }));
}

function collectQuestions(sess) {
  const questionId = (id) => {
    if (typeof id !== 'number' && (typeof id !== 'string' || !id.trim())) return null;
    const number = Number(id);
    return Number.isFinite(number) ? number : null;
  };
  const out = (sess.questions || [])
    .filter((q) => q && q.title)
    .map((q) => ({ id: questionId(q.id), title: String(q.title), ts: q.ts || null }));
  const live = sess.question;
  if (live && live.title && !out.some((q) => q.id === Number(live.id))) {
    out.push({ id: questionId(live.id), title: String(live.title), ts: live.ts || null });
  }
  return out;
}

function parseRecruiterMemory(md) {
  const out = {};
  for (const title of MEMORY_SECTIONS) {
    const body = extractSection(md, title);
    if (body) out[title] = body;
  }
  return Object.keys(out).length ? out : null;
}

function parseSessionFolder(dir) {
  const folder = path.basename(dir);
  const file = path.join(dir, 'session.json');
  if (!fs.existsSync(file)) throw new NotFoundError(`${folder}: session.json not found`);
  let sess;
  try { sess = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { throw new InputError(`${folder}: session.json is not valid JSON`); }
  if (!sess || typeof sess.round !== 'string') {
    throw new InputError(`${folder}: session.json needs "round" as a string`);
  }
  if (sess.questions !== undefined && !Array.isArray(sess.questions)) {
    throw new InputError(`${folder}: session.json "questions" must be an array`);
  }
  if (!Number.isFinite(sess.started_at)) {
    throw new InputError(`${folder}: session.json needs a numeric "started_at"`);
  }
  const legacy = sess.contractVersion === undefined || sess.contractVersion === null;
  if (!legacy) assertContract(sess.contractVersion, `session ${folder}`);

  const debrief = readText(path.join(dir, 'debrief.md'));
  const startSec = sess.started_at;
  const total = parseTotalSeconds(debrief);
  const endSec = typeof sess.endedAt === 'number' ? sess.endedAt : (startSec != null && total != null ? startSec + total : null);
  const phases = phaseMinutes(sess.phase_history, endSec);
  const durationMin = startSec != null && endSec != null
    ? Math.round((endSec - startSec) / 60)
    : Math.round(phases.reduce((s, p) => s + p.minutes, 0));

  return {
    folder,
    legacy,
    contractVersion: legacy ? null : sess.contractVersion,
    roleKey: !legacy && typeof sess.roleKey === 'string' && sess.roleKey ? sess.roleKey : null,
    round: sess.round,
    practice: !legacy && !!sess.practiceSet,
    practiceSet: legacy ? null : (sess.practiceSet || null),
    practiceResults: !legacy && Array.isArray(sess.practiceResults) ? sess.practiceResults : [],
    startedAt: new Date(startSec * 1000).toISOString(),
    durationMin,
    interviewer: parseInterviewer(debrief),
    questions: collectQuestions(sess),
    phases,
    scorecard: extractSection(debrief, 'Scorecard'),
    recruiterMemory: sess.round === 'recruiter' ? parseRecruiterMemory(debrief) : null,
    debrief,
  };
}

module.exports = { extractSection, parseSessionFolder };
