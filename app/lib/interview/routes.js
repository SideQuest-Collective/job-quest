// app/lib/interview/routes.js
// Dashboard API for the /interview integration (spec §4).
const fs = require('fs');
const path = require('path');
const { CONTRACT, INTERVIEW_REPO, ROUNDS, InputError, NotFoundError, assertFolderName, interviewInstalled } = require('./contract');
const records = require('./records');
const { ingestSession, setLink } = require('./ingest');
const { writeInterviewContext } = require('./context');

function isBusy(err) {
  return /^busy:/.test(err.message || '');
}

function httpStatus(err) {
  if (err.code === 'INPUT') return 400;
  if (err.code === 'NOT_FOUND') return 404;
  if (err.code === 'CONTRACT' || isBusy(err)) return 409;
  return 500;
}

function summary(r, inflight) {
  const e = r.effects || {};
  return {
    folder: r.folder,
    status: r.status,
    roleKey: r.roleKey || null,
    round: r.round || null,
    practice: !!r.practice,
    startedAt: r.startedAt || null,
    durationMin: r.durationMin == null ? null : r.durationMin,
    interviewer: r.interviewer || null,
    firstQuestion: (r.questions && r.questions[0] && r.questions[0].title) || null,
    questionCount: (r.questions || []).length,
    effects: {
      timeline: (e.timeline || []).length,
      stage: e.stage || null,
      questionsAdded: (e.workbookQids || []).length,
      tasks: (e.tasks || []).length,
      grades: (e.progress || []).length,
    },
    analysisError: r.analysisError || null,
    lastError: r.lastError || null,
    ingesting: inflight.has(r.folder),
  };
}

function registerInterviewRoutes(app, { dataDir, interviewHome, now = () => new Date(), runAgentFn }) {
  const inflight = new Map();
  const handle = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) { res.status(httpStatus(err)).json({ error: err.message }); }
  };
  const sessionDir = (folder) => path.join(interviewHome, 'sessions', assertFolderName(folder));
  const wait = (req) => req.query.wait === '1' || req.query.wait === 'true';
  const startIngest = (folder) => {
    if (!inflight.has(folder)) {
      const p = ingestSession({ dataDir, interviewHome, folder, now, runAgentFn })
        .then(async (result) => {
          await records.withLock(dataDir, folder, () => {
            const rec = records.readRecord(dataDir, folder);
            if (rec) records.writeRecord(dataDir, { ...rec, lastError: null });
          });
          return result;
        })
        .catch(async (err) => {
          console.error(`[interview] ${folder}: ${err.message}`);
          // Do not overwrite an active ingest's record when its lock is busy.
          if (!isBusy(err)) {
            try {
              await records.withLock(dataDir, folder, () => {
                const rec = records.readRecord(dataDir, folder);
                if (rec) records.writeRecord(dataDir, { ...rec, status: 'failed', applied: false, lastError: err.message });
              }, { waitMs: 0 });
            } catch (recordError) {
              console.error(`[interview] ${folder}: could not record failure: ${recordError.message}`);
            }
          }
          throw err;
        })
        .finally(() => inflight.delete(folder));
      inflight.set(folder, p);
      // Background callers leave the promise unawaited; wait=1 still receives
      // the original rejection so handle() can preserve its HTTP status.
      p.catch(() => {});
    }
    return inflight.get(folder);
  };

  app.get('/api/interview/status', handle(async () => {
    const all = records.listRecords(dataDir);
    return {
      installed: interviewInstalled(interviewHome), interviewHome, contract: CONTRACT, repo: INTERVIEW_REPO,
      sessions: all.length, unlinked: all.filter((r) => r.status === 'unlinked').length,
    };
  }));

  app.get('/api/interview/sessions', handle(async (req) => {
    let all = records.listRecords(dataDir);
    if (req.query.roleKey) all = all.filter((r) => r.roleKey === req.query.roleKey);
    if (req.query.status) all = all.filter((r) => r.status === req.query.status);
    return all.map((r) => summary(r, inflight));
  }));

  app.get('/api/interview/sessions/:folder', handle(async (req) => {
    const folder = assertFolderName(req.params.folder);
    const rec = records.readRecord(dataDir, folder);
    if (!rec) throw new NotFoundError(`no record for session ${folder}`);
    const debrief = path.join(sessionDir(folder), 'debrief.md');
    return { ...rec, ingesting: inflight.has(folder), debriefMarkdown: fs.existsSync(debrief) ? fs.readFileSync(debrief, 'utf-8') : null };
  }));

  app.get('/api/interview/sessions/:folder/transcript', handle(async (req) => {
    const folder = assertFolderName(req.params.folder);
    const file = path.join(sessionDir(folder), 'transcript.md');
    if (!fs.existsSync(file)) throw new NotFoundError(`no transcript.md for session ${folder}`);
    return { folder, markdown: fs.readFileSync(file, 'utf-8') };
  }));

  app.post('/api/interview/sessions/:folder/link', handle(async (req) => {
    const folder = assertFolderName(req.params.folder);
    const { roleKey } = req.body || {};
    await setLink({ dataDir, interviewHome, folder, roleKey, now });
    const p = startIngest(folder);
    return wait(req) ? p : { status: 'linking', folder, roleKey };
  }));

  app.post('/api/interview/sessions/:folder/ingest', handle(async (req) => {
    const folder = assertFolderName(req.params.folder);
    if (!fs.existsSync(path.join(sessionDir(folder), 'session.json'))) throw new NotFoundError(`session folder not found: ${folder}`);
    const p = startIngest(folder);
    return wait(req) ? p : { status: 'started', folder };
  }));

  app.post('/api/interview/context', handle(async (req) => {
    const { roleKey, round } = req.body || {};
    if (!roleKey) throw new InputError('roleKey is required');
    if (round != null && !ROUNDS.includes(round)) throw new InputError(`round must be one of ${ROUNDS.join(', ')}`);
    return writeInterviewContext({ dataDir, interviewHome, roleKey, round: round || null, runAgentFn });
  }));

  return { inflight };
}

module.exports = { registerInterviewRoutes, httpStatus };
