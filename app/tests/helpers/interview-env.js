// app/tests/helpers/interview-env.js
// Temp-dir helpers for interview tests. Never points at the real ~/.interview or ~/.job-quest.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'interview');
const FIXTURE_FOLDER = '2026-03-14_0930';
const FAKE_AGENT = path.join(__dirname, '..', 'fixtures', 'fake-agent.js');
const FAKE_ANALYST = path.join(FIXTURE_DIR, 'fake-analyst.js');
const FAKE_CHEATSHEET = path.join(FIXTURE_DIR, 'fake-cheatsheet.js');
const WORKBOOK_CHAPTER = path.join(FIXTURE_DIR, 'workbook-chapter.md');
const ROLE_KEY = 'Acme Capital|Software Engineer';

function makeEnv({ installed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-iv-'));
  const dataDir = path.join(root, 'data');
  const interviewHome = path.join(root, 'interview');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(interviewHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(interviewHome, 'context'), { recursive: true });
  if (installed) {
    fs.mkdirSync(path.join(interviewHome, 'app'), { recursive: true });
    fs.writeFileSync(path.join(interviewHome, 'app', 'capture.py'), '# stub for discovery\n');
  }
  return { root, dataDir, interviewHome };
}

function copyFixtureSession(interviewHome, folder = FIXTURE_FOLDER) {
  const dest = path.join(interviewHome, 'sessions', folder);
  fs.cpSync(path.join(FIXTURE_DIR, FIXTURE_FOLDER), dest, { recursive: true });
  return dest;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf-8')); }

function setSessionFields(dir, patch) {
  const file = path.join(dir, 'session.json');
  const sess = { ...readJson(file), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete sess[k];
  fs.writeFileSync(file, JSON.stringify(sess, null, 2));
  return sess;
}

function seedTracker(dataDir, entries) {
  fs.writeFileSync(path.join(dataDir, 'role-tracker.json'), JSON.stringify(entries, null, 2));
}

function seedRole(dataDir, stage = 'applied', extra = {}) {
  seedTracker(dataDir, {
    [ROLE_KEY]: {
      stage, notes: '', checklist: [],
      timeline: [{ date: '2026-03-01T12:00:00.000Z', event: 'Applied' }],
      url: 'https://jobs.example.com/acme/swe', level: 'Senior', location: 'New York, NY',
      ...extra,
    },
  });
}

function seedWorkbook(dataDir, roleKey = ROLE_KEY) {
  const bridge = require('../../lib/interview/workbook-bridge');
  const [company, role] = roleKey.split('|');
  const wb = bridge.ensureWorkbook(dataDir, { roleKey, company, role });
  fs.mkdirSync(path.join(wb.dir, 'content'), { recursive: true });
  fs.copyFileSync(WORKBOOK_CHAPTER, path.join(wb.dir, 'content', '01-coding-basics.md'));
  return wb;
}

function installFake(dir, agent, scriptPath) {
  fs.mkdirSync(path.join(dir, '.fake'), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(dir, '.fake', `${agent}.js`));
}

function installFakeAnalyst(dataDir, folder = FIXTURE_FOLDER, scriptPath = FAKE_ANALYST) {
  installFake(path.join(dataDir, 'interview-work', 'sessions', folder), 'debrief-analyst', scriptPath);
}

function fakeCalls(dir) {
  return require('../fixtures/fake-calls').readFakeCalls(dir);
}

function withFakeAgent(t) {
  const prev = process.env.JOB_QUEST_FAKE_AGENT;
  process.env.JOB_QUEST_FAKE_AGENT = FAKE_AGENT;
  t.after(() => {
    if (prev === undefined) delete process.env.JOB_QUEST_FAKE_AGENT;
    else process.env.JOB_QUEST_FAKE_AGENT = prev;
  });
}

function pinned(iso) { const t = new Date(iso); return () => new Date(t.getTime()); }

module.exports = {
  FIXTURE_DIR, FIXTURE_FOLDER, FAKE_AGENT, FAKE_ANALYST, FAKE_CHEATSHEET, WORKBOOK_CHAPTER, ROLE_KEY,
  makeEnv, copyFixtureSession, readJson, setSessionFields, seedTracker, seedRole, seedWorkbook,
  installFake, installFakeAnalyst, fakeCalls, withFakeAgent, pinned,
};
