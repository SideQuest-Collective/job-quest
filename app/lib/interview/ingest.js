// app/lib/interview/ingest.js
// Ingest one /interview session into Job Quest (spec §3). Code does every step except the debrief analysis.
const fs = require('fs');
const path = require('path');
const { InputError, NotFoundError, assertFolderName } = require('./contract');
const { parseSessionFolder } = require('./session-parse');
const records = require('./records');
const trackerFx = require('./tracker-effects');
const taskFx = require('./task-effects');
const { analyzeDebrief } = require('./analysis');
const markup = require('./workbook-markup');
const bridge = require('./workbook-bridge');
// Ruling 13.3 explicitly requires P1's metadata bump after a chapter rebuild.
const store = require('../workbook/store');
const { isKnownRole } = require('./roles');
const { resolveRole, splitRoleKey } = require('../jobs/roles');
const { slugify } = require('../jobs/slug');
const { getLocalDateStamp } = require('../local-date');

const emptyEffects = () => ({ timeline: [], stage: null, workbookQids: [], tasks: [], progress: [] });
const localDate = (iso) => getLocalDateStamp(new Date(iso));

function resolveFolder(interviewHome, folder) {
  const raw = String(folder || '');
  const abs = path.isAbsolute(raw) ? raw : path.join(interviewHome, 'sessions', assertFolderName(raw));
  assertFolderName(path.basename(abs));
  if (!fs.existsSync(path.join(abs, 'session.json'))) throw new NotFoundError(`session folder not found: ${raw}`);
  return abs;
}

function knownTopics(dataDir, roleKey) {
  const wb = bridge.findWorkbook(dataDir, roleKey);
  if (!wb) return [];
  return [...new Set(bridge.readWorkbook(dataDir, wb.id).questions.map((q) => q.topic).filter(Boolean))];
}

function rebuildInterviewChapter(dataDir, workbookId) {
  renderInterviewChapter(dataDir, workbookId);
}

function renderInterviewChapter(dataDir, workbookId, pending) {
  if (!bridge.workbookExists(dataDir, workbookId)) return;
  // Include the current transaction without claiming ingestion succeeded before
  // all effects were written. The public rebuild uses only ingested records.
  const all = records.listRecords(dataDir).filter((r) => !pending || r.folder !== pending.folder);
  if (pending) all.push(pending);
  const recs = all
    .filter((r) => r.workbookId === workbookId && (r === pending || r.status === 'ingested') && !r.practice && r.analysis && r.analysis.asked.length)
    .sort((a, b) => a.folder.localeCompare(b.folder));
  if (!recs.length) { bridge.removeInterviewChapter(dataDir, workbookId); return; }
  const companySlug = slugify(splitRoleKey(recs[0].roleKey).company);
  const sessions = recs.map((r) => ({
    date: localDate(r.startedAt), round: r.round, interviewer: r.interviewer, durationMin: r.durationMin, count: r.analysis.asked.length,
  }));
  const questions = recs.flatMap((r) => r.analysis.asked.map((item, i) => ({
    qid: markup.qidFor(r.folder, i + 1), item, date: localDate(r.startedAt), round: r.round,
  })));
  bridge.writeInterviewChapter(dataDir, workbookId, markup.renderChapter({ companySlug, sessions, questions }));
  store.writeMeta(dataDir, store.readMeta(dataDir, workbookId));
}

function readTracker(dataDir) {
  try { return trackerFx.readTracker(dataDir); } catch (cause) {
    throw new Error(`Cannot ingest: failed to read ${path.join(dataDir, 'role-tracker.json')}: ${cause.message}`, { cause });
  }
}

function isApplied(dataDir, rec) {
  if (!rec || !rec.applied || !rec.effects) return false;
  if (!rec.analysis && rec.analysisError && (rec.analysisAttempts || 0) < 2) return false;
  const entry = readTracker(dataDir)[rec.roleKey];
  if (!entry || !Array.isArray(entry.timeline) || !entry.timeline.some((e) => e && e.key === `interview:${rec.folder}`)) return false;
  const stage = rec.effects.stage;
  // Off-ladder stages (offer/rejected/etc.) remain user-owned, as in applyStage.
  if (stage && Object.prototype.hasOwnProperty.call(trackerFx.STAGE_RANK, entry.stage) &&
      trackerFx.STAGE_RANK[entry.stage] < trackerFx.STAGE_RANK[stage.to]) return false;
  if (taskFx.missingTaskKeys(dataDir, rec.effects.tasks).length) return false;
  if (rec.workbookId && bridge.workbookExists(dataDir, rec.workbookId) && rec.effects.workbookQids.length) {
    const qids = new Set(bridge.readWorkbook(dataDir, rec.workbookId).questions.map((q) => q.id));
    if (!rec.effects.workbookQids.every((qid) => qids.has(qid))) return false;
  }
  if (rec.workbookId && rec.effects.progress.length && bridge.workbookExists(dataDir, rec.workbookId)) {
    const history = bridge.readProgress(dataDir, rec.workbookId).history || {};
    const rejected = new Set((rec.gradeRejected || []).map((g) => g.qid));
    if (!rec.effects.progress.every((p) => rejected.has(p.qid) || (history[p.qid] || [])
      .some((h) => h.at === p.at && h.grade === p.grade && h.source === (p.source || 'interview')))) return false;
  }
  return true;
}

function progressEffects(record, prev, now) {
  const priorGrades = new Map(((prev && prev.effects && prev.effects.progress) || []).map((g) => [g.qid, g]));
  return record.analysis ? record.analysis.asked.map((a, i) => {
    const qid = markup.qidFor(record.folder, i + 1);
    const prior = priorGrades.get(qid);
    const changed = prior && prev.hash !== record.hash && prior.grade !== a.grade;
    const at = changed ? now().toISOString() : (prior && prior.at) || record.startedAt;
    return { qid, grade: a.grade, at };
  }) : [];
}

function practiceWorkbookId(dataDir, practiceSet, roleKey) {
  try {
    const set = JSON.parse(fs.readFileSync(practiceSet, 'utf-8'));
    if (set && set.workbookId && bridge.workbookExists(dataDir, set.workbookId)) return set.workbookId;
  } catch {
    // Missing or unreadable practice sets fall back to the linked role.
  }
  const wb = bridge.findWorkbook(dataDir, roleKey);
  return wb ? wb.id : null;
}

function applyEffects({ dataDir, parsed, record, prev, role, now }) {
  const key = `interview:${record.folder}`;
  const effects = emptyEffects();
  const practiceDropped = [];
  const grades = record.effects.progress.map((g) => ({ ...g, source: 'interview' }));
  effects.workbookQids = grades.map((g) => g.qid);
  effects.progress = grades.map(({ qid, grade, at }) => ({ qid, grade, at }));
  effects.stage = (!record.practice && prev && prev.roleKey === record.roleKey && prev.effects && prev.effects.stage) || null;
  record.effects = effects;
  records.writeRecord(dataDir, record);

  // This fresh read and write are synchronous, under the folder lock, and after
  // analysis. Never retain the role resolver's tracker snapshot across the agent.
  const tracker = readTracker(dataDir);
  for (const old of record.pendingCleanup) {
    if (old.roleKey && old.roleKey !== record.roleKey && tracker[old.roleKey]) {
      trackerFx.removeTimeline(trackerFx.ensureEntry(tracker, old.roleKey), key);
    }
  }
  const entry = trackerFx.ensureEntry(tracker, record.roleKey);
  trackerFx.upsertTimeline(entry, { key, date: record.startedAt, event: trackerFx.timelineEvent(record) });
  effects.timeline = [key];
  const change = trackerFx.applyStage(entry, record.round, record.practice);
  effects.stage = change || effects.stage;
  if (record.round === 'recruiter' && !record.practice && parsed.recruiterMemory) {
    const stripMarkers = (text) => String(text).replace(/\[\/?interview:[^\]\r\n]*\]/g, '');
    const memory = Object.fromEntries(Object.entries(parsed.recruiterMemory)
      .map(([title, body]) => [stripMarkers(title), stripMarkers(body)]));
    trackerFx.upsertRecruiterNotes(entry, record.folder, localDate(record.startedAt), memory);
  }
  trackerFx.writeTracker(dataDir, tracker);

  if (record.workbookId && record.analysis && record.analysis.asked.length) {
    renderInterviewChapter(dataDir, record.workbookId, record);
    const { rejected } = bridge.recordGrades(dataDir, record.workbookId, grades);
    record.gradeRejected = rejected;
  }
  for (const old of record.pendingCleanup) {
    if (old.workbookId && old.workbookId !== record.workbookId) rebuildInterviewChapter(dataDir, old.workbookId);
  }

  if (record.practice) {
    const known = record.workbookId ? new Set(bridge.readWorkbook(dataDir, record.workbookId).questions.map((q) => q.id)) : new Set();
    const practiceGrades = [];
    parsed.practiceResults.forEach((r, index) => {
      if (!r || !known.has(String(r.qid)) || !['got', 'partial', 'missed'].includes(r.grade)) {
        practiceDropped.push({ kind: 'practiceResult', index, reason: `unknown qid or grade: ${r && r.qid} ${r && r.grade}` });
        return;
      }
      practiceGrades.push({ qid: String(r.qid), grade: r.grade, at: record.startedAt, source: 'interview-practice' });
    });
    if (practiceGrades.length) {
      const { rejected } = bridge.recordGrades(dataDir, record.workbookId, practiceGrades);
      record.gradeRejected = rejected;
      const rejectedQids = new Set(rejected.map((g) => g.qid));
      effects.progress = practiceGrades.filter((g) => !rejectedQids.has(g.qid));
    }
  }

  if (record.analysis && record.analysis.followUps.length) {
    const items = record.analysis.followUps.map((f, i) => ({
      dedupeKey: `${key}:${i + 1}`, text: f.text, due: f.due || null,
      content: `Follow-up from your ${record.round} round on ${localDate(record.startedAt)} (${role.company} — ${role.role}).`,
    }));
    taskFx.upsertTasks(dataDir, items, { now });
    effects.tasks = items.map((x) => x.dedupeKey);
  }
  return { effects, practiceDropped };
}

function summarize(rec, role) {
  const e = rec.effects;
  const parts = ['timeline updated'];
  if (e.stage) parts.push(`stage ${e.stage.from} -> ${e.stage.to}`);
  if (e.workbookQids.length) parts.push(`${e.workbookQids.length} question(s) in the workbook`);
  if (rec.practice) parts.push(`${e.progress.length} practice grade(s) recorded`);
  if (e.tasks.length) parts.push(`${e.tasks.length} follow-up task(s)`);
  if (rec.gradeRejected && rec.gradeRejected.length) {
    parts.push(`${rec.gradeRejected.length} grade(s) rejected (${rec.gradeRejected.map((g) => `${g.qid}: ${g.reason}`).join('; ')})`);
  }
  if (rec.analysisError) parts.push(rec.analysisAttempts < 2
    ? `debrief analysis failed and will be retried (${rec.analysisError})`
    : `debrief analysis failed (${rec.analysisError}); edit the session or debrief to retry`);
  return `Ingested ${rec.folder} into ${role.company} — ${role.role}: ${parts.join(', ')}.`;
}

async function ingestLocked({ dataDir, dir, name, now, runAgentFn }) {
  const parsed = parseSessionFolder(dir);
  const hash = records.sessionHash(dir);
  const prev = records.readRecord(dataDir, name);
  const link = (prev && prev.link) || null;
  const roleKey = (link && link.roleKey) || parsed.roleKey || null;
  const base = {
    folder: name, hash, roleKey, round: parsed.round, practice: parsed.practice,
    startedAt: parsed.startedAt, durationMin: parsed.durationMin, interviewer: parsed.interviewer,
    questions: parsed.questions, phases: parsed.phases, scorecard: parsed.scorecard,
    contractVersion: parsed.contractVersion, link,
  };

  if (!roleKey) {
    if (!(prev && prev.status === 'unlinked' && prev.hash === hash)) {
      records.writeRecord(dataDir, {
        ...base, status: 'unlinked', analysis: null, dropped: [], analysisError: null, analysisAttempts: 0,
        workbookId: null, effects: emptyEffects(), applied: false, ingestedAt: now().toISOString(),
      });
    }
    return {
      status: 'unlinked', folder: name, effects: emptyEffects(),
      summary: `${name} is not linked to a Job Quest role yet; link it on the dashboard or run: jq link-session ${name} "<Company|Role>"`,
    };
  }

  if (prev && prev.status === 'ingested' && prev.hash === hash && prev.roleKey === roleKey) {
    try {
      if (isApplied(dataDir, prev)) return { status: 'unchanged', folder: name, effects: prev.effects, summary: `${name} is already ingested; nothing changed.` };
    } catch (error) {
      records.writeRecord(dataDir, { ...prev, status: 'failed', applied: false });
      throw error;
    }
  }

  const sameInputs = !!(prev && prev.hash === hash);
  let analysis = null;
  let dropped = [];
  let analysisError = null;
  let analysisAttempts = 0;
  if (!parsed.practice) {
    if (sameInputs && (prev.analysis || prev.analysisAttempts >= 2)) {
      analysis = prev.analysis;
      dropped = (prev.dropped || []).filter((d) => d.kind !== 'practiceResult');
      analysisError = prev.analysisError || null;
      analysisAttempts = prev.analysisAttempts || 1;
    } else {
      analysisAttempts = (sameInputs ? prev.analysisAttempts || 0 : 0) + 1;
      const r = await analyzeDebrief({ dataDir, sessionDir: dir, parsed, knownTopics: knownTopics(dataDir, roleKey), runAgentFn });
      analysis = r.analysis;
      dropped = r.dropped;
      analysisError = r.error;
    }
  }

  const role = resolveRole(dataDir, roleKey);
  const record = {
    ...base, status: 'ingesting', analysis, dropped, analysisError, analysisAttempts, workbookId: null,
    effects: (prev && prev.effects) || emptyEffects(), applied: false, ingestedAt: now().toISOString(),
    // Keep cleanup targets across failed writes, including another re-link
    // before recovery. The current record will replace prev on disk below.
    pendingCleanup: [...((prev && prev.pendingCleanup) || [])],
  };
  if (prev && (prev.roleKey || prev.workbookId) && !record.pendingCleanup.some((old) =>
    old.roleKey === prev.roleKey && old.workbookId === prev.workbookId)) {
    record.pendingCleanup.push({ roleKey: prev.roleKey, workbookId: prev.workbookId });
  }
  // Cache analysis and planned grade timestamps before any effect writes. A
  // failed write can then retry this hash without analysis or timestamp drift.
  record.effects = { ...record.effects, progress: progressEffects(record, prev, now) };
  records.writeRecord(dataDir, record);
  try {
    if (analysis && analysis.asked.length) record.workbookId = bridge.ensureWorkbook(dataDir, { roleKey, company: role.company, role: role.role }).id;
    else if (parsed.practice) record.workbookId = practiceWorkbookId(dataDir, parsed.practiceSet, roleKey);
    const { effects, practiceDropped } = applyEffects({ dataDir, parsed, record, prev, role, now });
    record.effects = effects;
    record.dropped = dropped.concat(practiceDropped);
    record.applied = true;
    record.status = 'ingested';
    delete record.pendingCleanup;
    records.writeRecord(dataDir, record);
    return { status: 'ingested', folder: name, effects, summary: summarize(record, role) };
  } catch (error) {
    records.writeRecord(dataDir, { ...record, status: 'failed', applied: false });
    throw error;
  }
}

async function ingestSession({ dataDir, interviewHome, folder, now = () => new Date(), runAgentFn, lockWaitMs = 15000 }) {
  const dir = resolveFolder(interviewHome, folder);
  const name = path.basename(dir);
  return records.withLock(dataDir, name, () => ingestLocked({ dataDir, dir, name, now, runAgentFn }), { waitMs: lockWaitMs });
}

async function setLink({ dataDir, interviewHome, folder, roleKey, now = () => new Date() }) {
  if (typeof roleKey !== 'string' || roleKey.split('|').length !== 2 || roleKey.split('|').some((part) => !part.trim())) {
    throw new InputError('roleKey must look like "Company|Role"');
  }
  if (!isKnownRole(dataDir, roleKey)) throw new InputError(`unknown roleKey: ${roleKey}`);
  const dir = resolveFolder(interviewHome, folder);
  const name = path.basename(dir);
  await records.withLock(dataDir, name, async () => {
    const prev = records.readRecord(dataDir, name) || { folder: name, roleKey: null, effects: emptyEffects(), applied: false };
    records.writeRecord(dataDir, { ...prev, folder: name, status: 'linking', link: { roleKey, at: now().toISOString() } });
  });
  return dir;
}

async function linkSession({ dataDir, interviewHome, folder, roleKey, now = () => new Date(), runAgentFn, lockWaitMs }) {
  const dir = await setLink({ dataDir, interviewHome, folder, roleKey, now });
  return ingestSession({ dataDir, interviewHome, folder: dir, now, runAgentFn, lockWaitMs });
}

module.exports = { emptyEffects, resolveFolder, ingestSession, setLink, linkSession, rebuildInterviewChapter, isApplied };
