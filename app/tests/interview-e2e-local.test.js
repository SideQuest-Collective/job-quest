// app/tests/interview-e2e-local.test.js
// Local-only end-to-end check against a TEMP COPY of a real /interview session and the real tracker.
// Skipped unless JQ_E2E_FOLDER and JQ_E2E_COMPANY are set and the folder exists.
// Reads ~/.interview/sessions/<folder> and ~/.job-quest/data read-only; writes only to temp dirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ingestSession, linkSession } = require('../lib/interview/ingest');
const { listRolesForCompany } = require('../lib/interview/roles');
const { missingTaskKeys } = require('../lib/interview/task-effects');
const { STAGE_RANK } = require('../lib/interview/tracker-effects');
const bridge = require('../lib/interview/workbook-bridge');
const { makeEnv, installFakeAnalyst, withFakeAgent, readJson } = require('./helpers/interview-env');

const FOLDER = process.env.JQ_E2E_FOLDER;
const COMPANY = process.env.JQ_E2E_COMPANY;
const REAL_SESSION = FOLDER ? path.join(os.homedir(), '.interview', 'sessions', FOLDER) : '';
const REAL_DATA = path.join(os.homedir(), '.job-quest', 'data');
const skip = (!FOLDER || !COMPANY || !fs.existsSync(path.join(REAL_SESSION, 'session.json')))
  ? 'set JQ_E2E_FOLDER and JQ_E2E_COMPANY to run against a copy of a real session'
  : false;

function treeHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) { h.update(f); h.update(fs.readFileSync(p)); }
  }
  return h.digest('hex');
}

function stamp(file) {
  try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; }
}

test('real session copy: link, ingest, verify effects, re-ingest is unchanged', { skip }, async (t) => {
  withFakeAgent(t);
  const before = { session: treeHash(REAL_SESSION), tracker: stamp(path.join(REAL_DATA, 'role-tracker.json')) };
  const env = makeEnv();
  fs.cpSync(REAL_SESSION, path.join(env.interviewHome, 'sessions', FOLDER), { recursive: true });
  for (const f of ['role-tracker.json', 'role-actions.json', 'profile.json']) {
    if (fs.existsSync(path.join(REAL_DATA, f))) fs.copyFileSync(path.join(REAL_DATA, f), path.join(env.dataDir, f));
  }
  installFakeAnalyst(env.dataDir, FOLDER);
  const now = () => new Date('2026-10-05T12:00:00');
  const args = { dataDir: env.dataDir, interviewHome: env.interviewHome, folder: FOLDER, now };

  const roles = listRolesForCompany(env.dataDir, COMPANY);
  assert.ok(roles.length >= 1, `no tracker role matches ${COMPANY}`);
  const { roleKey } = roles[0];
  const stageBefore = (readJson(path.join(env.dataDir, 'role-tracker.json'))[roleKey] || {}).stage;

  const first = await ingestSession(args);
  assert.ok(['unlinked', 'ingested'].includes(first.status), first.status);
  const r = await linkSession({ ...args, roleKey });
  assert.equal(r.status, 'ingested');
  t.diagnostic(r.summary);

  const key = `interview:${FOLDER}`;
  const entry = readJson(path.join(env.dataDir, 'role-tracker.json'))[roleKey];
  const tl = entry.timeline.filter((x) => x.key === key);
  assert.equal(tl.length, 1);
  assert.match(tl[0].event, /^[A-Z][A-Za-z ]+ round( with [A-Za-z'’-]+)?, \d+ min(, practice)?$/);
  if (Object.prototype.hasOwnProperty.call(STAGE_RANK, stageBefore)) assert.ok(STAGE_RANK[entry.stage] >= STAGE_RANK[stageBefore]);
  else assert.equal(entry.stage, stageBefore);

  const wb = bridge.findWorkbook(env.dataDir, roleKey);
  assert.ok(wb, 'a workbook serves the role (a minimal one is created when none existed)');
  const asked = bridge.readWorkbook(env.dataDir, wb.id).questions.filter((q) => q.chapter === 'asked-in-interviews');
  assert.deepEqual(asked.map((q) => q.id), r.effects.workbookQids);
  const grades = bridge.readProgress(env.dataDir, wb.id).grades;
  assert.ok(r.effects.workbookQids.length > 0);
  assert.ok(r.effects.workbookQids.every((q) => grades[q] && grades[q].source === 'interview'));
  assert.ok(r.effects.workbookQids.some((q) => ['partial', 'missed'].includes(grades[q].grade)), 'a miss enters the review queue');
  assert.deepEqual(missingTaskKeys(env.dataDir, r.effects.tasks), []);

  const snap = () => [
    fs.readFileSync(path.join(env.dataDir, 'role-tracker.json'), 'utf-8'),
    fs.readdirSync(path.join(env.dataDir, 'tasks')).sort().map((f) => fs.readFileSync(path.join(env.dataDir, 'tasks', f), 'utf-8')).join('|'),
    JSON.stringify(bridge.readProgress(env.dataDir, wb.id)),
    fs.readFileSync(path.join(wb.dir, 'content', bridge.INTERVIEW_CHAPTER_FILE), 'utf-8'),
  ];
  const s1 = snap();
  assert.equal((await ingestSession(args)).status, 'unchanged');
  assert.deepEqual(snap(), s1);

  assert.equal(treeHash(REAL_SESSION), before.session, 'the real session folder is untouched');
  assert.equal(stamp(path.join(REAL_DATA, 'role-tracker.json')), before.tracker, 'the real tracker is untouched');
});
