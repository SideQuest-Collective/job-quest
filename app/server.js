const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const AdmZip = require('adm-zip');
const { ensureRuntime, expandHome } = require('../lib/runtime');
const { findRecordByDate, getLocalDateStamp, preferTodayOrLatest } = require('./lib/local-date');
const { createQueue } = require('./lib/jobs/queue');
const { readSettings, writeSettings } = require('./lib/jobs/settings');
const { diffRoleActions, diffTracker, createRoleEventBus } = require('./lib/jobs/role-events');
const { registerWorkbookRoutes, getWorkbookSdTopics } = require('./lib/workbook/routes');
const { createWorkbookHandler } = require('./lib/workbook/orchestrator');
const { createAutoBuild } = require('./lib/workbook/autobuild');
const workbookStore = require('./lib/workbook/store');
const { applyPlan } = require('./lib/prep/plan');
const { addProblems } = require('./lib/prep/problems');
const { runPythonTests, adaptersError, lintProblems } = require('./lib/codelab/runner');
const { createProblemStore } = require('./lib/codelab/store');
const { createResumeService } = require('./lib/resume/pipeline');
const { readMaster, writeMaster } = require('./lib/resume/master');
const { readTracker, writeTracker, mergeTrackerSnapshot } = require('./lib/interview/tracker-effects');

// Load .env file if present (no dependency needed)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// Optional user-owned local integrations. Nothing here installs or exposes networking.
const setupDataDir = path.resolve((process.env.DATA_DIR || path.join(os.homedir(), '.job-quest/data')).replace(/^~/, os.homedir()));
let localSetup = {};
try { localSetup = JSON.parse(fs.readFileSync(path.join(setupDataDir, 'local-setup.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Local setup is unreadable. Repair local-setup.json before starting; data was preserved.'); }
for (const [key, envKey] of Object.entries({careerBrief:'JOB_QUEST_CAREER_BRIEF',replyQueue:'JOB_QUEST_REPLY_QUEUE',privateOrigin:'JOB_QUEST_ALLOWED_ORIGINS',tailscaleUser:'JOB_QUEST_TAILSCALE_USER',interviewHome:'INTERVIEW_HOME'})) {
  if (localSetup[key] && !process.env[envKey]) process.env[envKey] = localSetup[key];
}
const app = express();
const { createRequestBoundary, validConversationId } = require('./lib/feedback/boundary');
const { createFeedbackService, safeId, targetLevel, write: writeFeedbackJson } = require('./lib/feedback/service');
app.use(createRequestBoundary());
const PORT = process.env.PORT || 3847;
const SERVER_INFO = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  version: require('./package.json').version,
};

// Let the tracker route return its JSON validation error for null and primitives too.
app.use('/api/role-tracker', express.json({ limit: '50mb', strict: false }));
app.use(express.json({ limit: '50mb' }));

const runtimeState = ensureRuntime({ write: true });
const runtimeDisplayName = runtimeState.runtimeDisplayName;
const runtimeCommandLabel = runtimeState.runtimeCommand;
const installScheduleCommand = `${expandHome(runtimeState.binDir)}/install-schedule.sh "3 7 * * 1-5"`;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR.replace(/^~/, os.homedir()))
  : expandHome(runtimeState.dataDir);

// Ensure DATA_DIR exists on startup
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- Shared job queue (workbooks, resume tailoring) ---
const jobHandlers = {};
const jobQueue = createQueue({ dataDir: DATA_DIR, handlers: jobHandlers });
const roleEvents = createRoleEventBus();
const feedbackService = createFeedbackService({ dataDir: DATA_DIR, queue: jobQueue, handlers: jobHandlers });
const feedbackRoute = fn => (req, res) => { try { fn(req, res); } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save or load feedback. Your existing data has been preserved.' }); } };
app.get('/api/feedback', feedbackRoute((req, res) => res.json({ attempts: feedbackService.list(req.query.questionId) })));
app.get('/api/feedback/:id', feedbackRoute((req, res) => {
  const attempt = feedbackService.get(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  res.json({ attempt });
}));
app.post('/api/feedback/:id/retry', feedbackRoute((req, res) => res.status(202).json(feedbackService.retry(req.params.id))));

app.get('/api/local-setup', (req,res) => res.json({localAvailable:true,privateConfigured:!!(process.env.JOB_QUEST_ALLOWED_ORIGINS && process.env.JOB_QUEST_TAILSCALE_USER),privateOrigin:process.env.JOB_QUEST_ALLOWED_ORIGINS || null,privateAuthenticated:!!req.headers['tailscale-user-login'],careerBriefConfigured:!!process.env.JOB_QUEST_CAREER_BRIEF,replyQueueConfigured:!!process.env.JOB_QUEST_REPLY_QUEUE,schedule:localSetup.schedule || 'not_selected'}));

app.get('/api/jobs', (req, res) => res.json(jobQueue.list()));
app.get('/api/settings', (req, res) => res.json(readSettings(DATA_DIR)));
app.put('/api/settings', (req, res) => res.json(writeSettings(DATA_DIR, req.body || {})));

// --- /interview integration (contract jq-interview/1; see CONTRACT.md) ---
const { registerInterviewRoutes } = require('./lib/interview/routes');
const { startScanner: startInterviewScanner } = require('./lib/interview/scanner');
const { interviewHome: resolveInterviewHome, interviewInstalled } = require('./lib/interview/contract');
const interviewRecords = require('./lib/interview/records');
const INTERVIEW_HOME = resolveInterviewHome(process.env);
registerInterviewRoutes(app, { dataDir: DATA_DIR, interviewHome: INTERVIEW_HOME });

// --- Workbooks (handler registered before jobQueue.start() at the bottom of this file) ---
jobHandlers.workbook = createWorkbookHandler({ dataDir: DATA_DIR });
const workbookAutoBuild = createAutoBuild({ dataDir: DATA_DIR, queue: jobQueue });
roleEvents.on('saved', (roleKey) => workbookAutoBuild.onRoleEvent('saved', roleKey));
roleEvents.on('applied', (roleKey) => workbookAutoBuild.onRoleEvent('applied', roleKey));
registerWorkbookRoutes(app, { dataDir: DATA_DIR, queue: jobQueue, autoBuild: workbookAutoBuild, publicDir: path.join(__dirname, 'public') });

// Validate workbook IDs before static middleware can normalize or redirect them.
app.use(express.static(path.join(__dirname, 'public')));

// Helper: read all JSON files from a directory, sorted by date desc
function readDataDir(subdir) {
  const dir = path.join(DATA_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// Helper: write JSON to data dir
function writeData(subdir, filename, data) {
  const dir = path.join(DATA_DIR, subdir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

// --- Activity Journal ---
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');

function readActivity() {
  if (fs.existsSync(ACTIVITY_FILE)) return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf-8'));
  return {};
}

function logActivity(type, detail) {
  const activity = readActivity();
  const today = getLocalDateStamp();
  if (!activity[today]) activity[today] = { events: [] };
  activity[today].events.push({
    type,
    detail,
    timestamp: new Date().toISOString(),
  });
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity, null, 2));
}

// --- Auto-complete daily tasks helper ---
// Marks today's daily tasks as completed when matching criteria is met
function autoCompleteDailyTask(matchFn) {
  const today = getLocalDateStamp();
  const taskFile = path.join(DATA_DIR, 'tasks', `${today}.json`);
  if (!fs.existsSync(taskFile)) return;
  const data = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
  if (!data.tasks) return;
  let changed = false;
  data.tasks.forEach((task, idx) => {
    if (!task.completed && matchFn(task)) {
      task.completed = true;
      changed = true;
      logActivity('task_auto_completed', { date: today, taskIndex: idx, task: task.text, trigger: 'auto' });
    }
  });
  if (changed) {
    fs.writeFileSync(taskFile, JSON.stringify(data, null, 2));
  }
}

// --- API Routes ---

app.get('/api/profile', (req, res) => {
  let name = null;
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'profile.json'), 'utf-8'));
    if (typeof profile?.name === 'string') name = profile.name.trim() || null;
  } catch {}
  res.json({ name });
});

app.get('/api/runtime', (req, res) => {
  const freshRuntime = ensureRuntime({ write: true });
  res.json({
    activeRuntime: freshRuntime.activeRuntime,
    detectedRuntime: freshRuntime.detectedRuntime,
    displayName: freshRuntime.runtimeDisplayName,
    command: freshRuntime.runtimeCommand,
    entryMode: freshRuntime.runtimeEntryMode,
    dataDir: expandHome(freshRuntime.dataDir),
    binDir: expandHome(freshRuntime.binDir),
    installScheduleCommand: `${expandHome(freshRuntime.binDir)}/install-schedule.sh "3 7 * * 1-5"`,
    validation: freshRuntime.runtimeValidation,
  });
});

// Get all intel reports
app.get('/api/intel', (req, res) => {
  res.json(readDataDir('intel'));
});

// Get latest intel
app.get('/api/intel/latest', (req, res) => {
  const all = readDataDir('intel');
  res.json(preferTodayOrLatest(all, getLocalDateStamp()));
});

// Get all quizzes
app.get('/api/quizzes', (req, res) => {
  res.json(readDataDir('quizzes'));
});

// Get today's quiz
app.get('/api/quizzes/today', (req, res) => {
  const today = getLocalDateStamp();
  const all = readDataDir('quizzes');
  res.json(preferTodayOrLatest(all, today));
});

// Submit quiz answer
app.post('/api/quizzes/answer', (req, res) => {
  const { quizDate, questionIndex, selectedAnswer, isCorrect } = req.body;
  const progressFile = path.join(DATA_DIR, 'progress.json');
  let progress = {};
  if (fs.existsSync(progressFile)) {
    progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
  }
  if (!progress.quizResults) progress.quizResults = {};
  if (!progress.quizResults[quizDate]) progress.quizResults[quizDate] = [];
  progress.quizResults[quizDate].push({ questionIndex, selectedAnswer, isCorrect, timestamp: new Date().toISOString() });
  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
  logActivity('quiz_answer', { quizDate, questionIndex, isCorrect });
  res.json({ success: true });
});

// Get all tasks
app.get('/api/tasks', (req, res) => {
  res.json(readDataDir('tasks'));
});

// Get today's tasks
app.get('/api/tasks/today', (req, res) => {
  const today = getLocalDateStamp();
  const all = readDataDir('tasks');
  res.json(preferTodayOrLatest(all, today));
});

// Update task status
app.post('/api/tasks/update', (req, res) => {
  const { date, taskIndex, completed } = req.body;
  const dir = path.join(DATA_DIR, 'tasks');
  const filename = `${date}.json`;
  const filepath = path.join(dir, filename);
  if (fs.existsSync(filepath)) {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    if (data.tasks && data.tasks[taskIndex]) {
      data.tasks[taskIndex].completed = completed;
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      logActivity('task_update', { date, taskIndex, task: data.tasks[taskIndex].text, completed });
    }
  }
  res.json({ success: true });
});

// Write a dated prep plan into Daily Tasks (replaces this plan's unfinished tasks from today on).
app.post('/api/tasks/plan', (req, res) => {
  try {
    const problemIds = new Set(problemStore.read().problems.map(p => p.id));
    const result = applyPlan(DATA_DIR, req.body, {
      today: getLocalDateStamp(),
      workbookExists: id => workbookStore.isValidId(id) && !!workbookStore.readMeta(DATA_DIR, id),
      problemExists: id => problemIds.has(id),
      sdTopicExists: id => !!getSdTopic(id),
    });
    logActivity('prep_plan_applied', result);
    res.json(result);
  } catch (err) {
    res.status(err.code === 'INPUT' ? 400 : 500).json({ error: err.message });
  }
});

// Get progress/stats
app.get('/api/progress', (req, res) => {
  const progressFile = path.join(DATA_DIR, 'progress.json');
  let progress = {};
  if (fs.existsSync(progressFile)) {
    progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
  }
  // Aggregate stats
  const allTasks = readDataDir('tasks');
  const allQuizzes = readDataDir('quizzes');
  let totalTasks = 0, completedTasks = 0;
  allTasks.forEach(day => {
    if (day.tasks) {
      totalTasks += day.tasks.length;
      completedTasks += day.tasks.filter(t => t.completed).length;
    }
  });
  let totalQuestions = 0, correctAnswers = 0;
  if (progress.quizResults) {
    Object.values(progress.quizResults).forEach(answers => {
      totalQuestions += answers.length;
      correctAnswers += answers.filter(a => a.isCorrect).length;
    });
  }
  res.json({
    ...progress,
    totalTasks, completedTasks,
    totalQuestions, correctAnswers,
    daysActive: new Set([...Object.entries(readActivity()).filter(([,day]) => day?.events?.some(e => ['quiz_answer','code_solved','task_update','feedback_reviewed'].includes(e.type))).map(([date])=>date), ...allTasks.filter(day=>day.tasks?.some(t=>t.completed)).map(day=>day.date)]).size,
    quizDays: Object.keys(progress.quizResults || {}).length,
    streak: calculateStreak(allTasks)
  });
});

function calculateStreak(allTasks) {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 60; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = getLocalDateStamp(d);
    const dayTasks = findRecordByDate(allTasks, dateStr);
    if (dayTasks && dayTasks.tasks && dayTasks.tasks.some(t => t.completed)) {
      streak++;
    } else if (i > 0) break;
  }
  return streak;
}

// Lightweight status for menu bar / xbar plugin
app.get('/api/status', (req, res) => {
  // A damaged data source should only affect its own status fields.
  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const array = (value) => Array.isArray(value) ? value : [];
  const today = getLocalDateStamp();
  const allTasks = read(() => readDataDir('tasks'), []);
  const todayTasks = findRecordByDate(allTasks, today);
  const tasks = array(todayTasks?.tasks);
  const tasksTotal = tasks.length;
  const tasksDone = tasks.filter(t => t?.completed).length;

  const allIntel = read(() => readDataDir('intel'), []);
  const todayIntel = preferTodayOrLatest(allIntel, today);
  const roles = array(todayIntel?.roles);
  const intelDate = typeof todayIntel?.date === 'string' ? todayIntel.date : null;
  const intelIsToday = intelDate === today;

  const allQuizzes = read(() => readDataDir('quizzes'), []);
  const todayQuiz = preferTodayOrLatest(allQuizzes, today);
  const quizQuestions = array(todayQuiz?.questions);

  const progress = read(() => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'progress.json'), 'utf-8')), null);
  const todayQuizResults = array(progress?.quizResults?.[today]);
  const quizAnswered = todayQuizResults.length;
  const quizCorrect = todayQuizResults.filter(a => a?.isCorrect).length;

  const roleActions = read(() => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'role-actions.json'), 'utf-8')), null);
  const unlinked = read(() => interviewInstalled(INTERVIEW_HOME)
    ? interviewRecords.listRecords(DATA_DIR).filter(record => record.status === 'unlinked' && !record.dismissed).length
    : 0, 0);

  res.json({
    ok: true,
    date: today,
    intelDate,
    intelIsToday,
    rolesToday: roles.length,
    tasks: { done: tasksDone, total: tasksTotal },
    quiz: { answered: quizAnswered, total: quizQuestions.length, correct: quizCorrect },
    roles: {
      saved: array(roleActions?.saved).length,
      applied: array(roleActions?.applied).length,
    },
    streak: read(() => calculateStreak(allTasks), 0),
    interview: { unlinked },
    server: SERVER_INFO,
  });
});

// Get applications tracker data
app.get('/api/applications', (req, res) => {
  const file = path.join(DATA_DIR, 'applications.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } else {
    res.json({ applications: [] });
  }
});

// Update application
app.post('/api/applications/update', (req, res) => {
  const file = path.join(DATA_DIR, 'applications.json');
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// Resume endpoints
app.get('/api/resume', (req, res) => {
  const file = path.join(DATA_DIR, 'resume.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } else {
    res.json({ contact: { name: '', email: '', phone: '', location: '', linkedin: '', github: '' }, summary: '', experience: [], education: [], skills: [] });
  }
});

app.post('/api/resume', (req, res) => {
  const file = path.join(DATA_DIR, 'resume.json');
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  logActivity('resume_update', { name: req.body.contact?.name });
  res.json({ success: true });
});

// Role actions (save/skip/apply from discover carousel)
app.get('/api/role-actions', (req, res) => {
  const file = path.join(DATA_DIR, 'role-actions.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } else {
    res.json({ saved: [], skipped: [], applied: [] });
  }
});

app.post('/api/role-actions', (req, res) => {
  const prev = fs.existsSync(path.join(DATA_DIR, 'role-actions.json')) ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'role-actions.json'), 'utf-8')) : { saved: [], skipped: [], applied: [] };
  const file = path.join(DATA_DIR, 'role-actions.json');
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  // Log new actions
  const newSaved = (req.body.saved || []).filter(r => !(prev.saved || []).includes(r));
  const newSkipped = (req.body.skipped || []).filter(r => !(prev.skipped || []).includes(r));
  const newApplied = (req.body.applied || []).filter(r => !(prev.applied || []).includes(r));
  if (newSaved.length) logActivity('role_saved', { roles: newSaved });
  if (newSkipped.length) logActivity('role_skipped', { roles: newSkipped });
  if (newApplied.length) logActivity('role_applied', { roles: newApplied });
  const roleDiff = diffRoleActions(prev, req.body);
  roleDiff.saved.forEach((k) => roleEvents.emit('saved', k));
  roleDiff.applied.forEach((k) => roleEvents.emit('applied', k));
  res.json({ success: true });
});

// Role tracker (Intel mission control)
app.get('/api/role-tracker', (req, res) => {
  const file = path.join(DATA_DIR, 'role-tracker.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } else {
    res.json({});
  }
});

app.post('/api/role-tracker', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'tracker body must be an object' });
  }
  const prev = readTracker(DATA_DIR);
  const merged = mergeTrackerSnapshot(prev, req.body);
  writeTracker(DATA_DIR, merged);
  Object.keys(merged).forEach(key => {
    if (!prev[key]) {
      logActivity('role_tracked', { role: key, stage: merged[key].stage });
    } else if (prev[key].stage !== merged[key].stage) {
      logActivity('role_stage_change', { role: key, from: prev[key].stage, to: merged[key].stage });
    }
  });
  diffTracker(prev, merged).applied.forEach((k) => roleEvents.emit('applied', k));
  res.json({ success: true });
});

// --- Evaluate Practice Answer ---
app.post('/api/evaluate-answer', feedbackRoute((req, res) => res.status(202).json(feedbackService.submit('behavioral', req.body))));

// --- Behavioral Practice ---
const BEHAVIORAL_DIR = path.join(DATA_DIR, 'behavioral');

app.get('/api/behavioral/answers', (req, res) => {
  if (!fs.existsSync(BEHAVIORAL_DIR)) fs.mkdirSync(BEHAVIORAL_DIR, { recursive: true });
  const answersFile = path.join(BEHAVIORAL_DIR, 'answers.json');
  if (fs.existsSync(answersFile)) {
    res.json(JSON.parse(fs.readFileSync(answersFile, 'utf-8')));
  } else {
    res.json({});
  }
});

app.post('/api/behavioral/answers', feedbackRoute((req, res) => {
  const answersFile = path.join(BEHAVIORAL_DIR, 'answers.json');
  const existing = fs.existsSync(answersFile) ? JSON.parse(fs.readFileSync(answersFile, 'utf-8')) : {};
  const { key, answer, expectedRevision, question } = req.body;
  if (!safeId(key) || typeof answer !== 'string') return res.status(400).json({ error: 'Valid key and answer required' });
  const previous = Object.hasOwn(existing, key) ? existing[key] : {};
  if (expectedRevision !== undefined && expectedRevision !== (previous.revision || 0)) return res.status(409).json({ error: 'This answer changed on another device. Reload before saving.', current: previous });
  existing[key] = { ...previous, answer, revision: (previous.revision || 0) + 1, updatedAt: new Date().toISOString(), ...(typeof question === 'string' ? { question } : {}) };
  // Evaluations are written only by successful server-side reviews, never client errors.
  writeFeedbackJson(answersFile, existing);
  res.json({ success: true, answer: existing[key], revision: existing[key].revision });
}));

// --- Behavioral Draft Generation ---
app.post('/api/behavioral/generate-draft', (req, res) => {
  const { question, resumeData, userContext } = req.body;
  const requestId = `beh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[${requestId}] Generating behavioral draft for: ${question?.slice(0, 60)}...`);

  const resumeSection = resumeData?.summary || resumeData?.experience?.length
    ? `CANDIDATE'S RESUME:\nName: ${resumeData.contact?.name || 'Unknown'}\nSummary: ${resumeData.summary || 'Not provided'}\nExperience:\n${(resumeData.experience || []).map(e => `- ${e.title} at ${e.company} (${e.duration || ''})\n  ${(e.bullets || []).join('\n  ')}`).join('\n')}\nSkills: ${(resumeData.skills || []).join(', ')}`
    : 'No detailed resume available.';

  const contextSection = userContext
    ? `\nADDITIONAL CONTEXT FROM CANDIDATE:\n${userContext}`
    : '';

  const prompt = `You are an interview coach for ${targetLevel(DATA_DIR)} helping a candidate prepare a STAR-format behavioral answer.

BEHAVIORAL QUESTION: ${question}

${resumeSection}
${contextSection}

${userContext ? `Using the candidate's own context and resume, write a compelling STAR-format behavioral answer in FIRST PERSON as if the candidate is speaking. Make it specific and authentic based on what they told you.` : `Based on the resume, determine if there is enough information to write a specific STAR answer.

If there IS enough info from the resume, write a compelling STAR-format answer in FIRST PERSON.

If there is NOT enough info, respond with a JSON object containing questions to ask the candidate.`}

Your response must be a single JSON object with no other text:
${userContext ? '{"draft":"The complete STAR answer written in first person..."}' : '{"draft":"The STAR answer if enough info...","needsMoreInfo":false} OR {"needsMoreInfo":true,"questions":["Specific question 1 about their experience","Question 2","Question 3"]}'}

Output ONLY the JSON object.`;

  const tmpPrompt = path.join(os.tmpdir(), `beh_${Date.now()}.txt`);
  fs.writeFileSync(tmpPrompt, prompt);
  const scriptPath = path.join(__dirname, 'scripts', 'generate-plan.sh');

  const { exec } = require('child_process');
  exec(`bash "${scriptPath}" "${tmpPrompt}"`, {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: os.homedir() },
  }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmpPrompt); } catch {}
    if (err) {
      console.error(`[${requestId}] Draft gen failed: ${err.message?.slice(0, 200)}`);
      res.json({ error: true, message: 'Draft generation failed. Please try again.' });
      return;
    }
    let raw = (stdout || '').trim();
    let result = null;
    try { result = JSON.parse(raw); } catch {}
    if (!result) {
      const jsonFence = raw.match(/```json\s*([\s\S]*?)```/);
      if (jsonFence) try { result = JSON.parse(jsonFence[1].trim()); } catch {}
    }
    if (!result) {
      const jsonStart = raw.indexOf('{"');
      if (jsonStart >= 0) {
        let depth = 0, jsonEnd = -1;
        for (let i = jsonStart; i < raw.length; i++) {
          if (raw[i] === '{') depth++; else if (raw[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd > jsonStart) try { result = JSON.parse(raw.slice(jsonStart, jsonEnd)); } catch {}
      }
    }
    if (result) {
      console.log(`[${requestId}] Draft gen success: needsMoreInfo=${result.needsMoreInfo}, draftLen=${(result.draft || '').length}`);
      res.json(result);
    } else {
      console.error(`[${requestId}] Draft parse failed, raw: ${raw.slice(0, 300)}`);
      res.json({ draft: raw.slice(0, 2000) });
    }
  });
});

// --- Interview Trainer ---
const TRAINER_DIR = path.join(DATA_DIR, 'trainer');
const TRAINER_QUESTIONS_FILE = path.join(TRAINER_DIR, 'questions.json');
const TRAINER_CONFIG_FILE = path.join(TRAINER_DIR, 'config.json');

function readTrainerQuestions() {
  if (!fs.existsSync(TRAINER_QUESTIONS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TRAINER_QUESTIONS_FILE, 'utf-8')); } catch { return []; }
}

function writeTrainerQuestions(questions) {
  if (!fs.existsSync(TRAINER_DIR)) fs.mkdirSync(TRAINER_DIR, { recursive: true });
  writeFeedbackJson(TRAINER_QUESTIONS_FILE, questions);
}

function readTrainerConfig() {
  if (!fs.existsSync(TRAINER_CONFIG_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TRAINER_CONFIG_FILE, 'utf-8')); } catch { return null; }
}

app.get('/api/trainer/questions', (req, res) => {
  res.json({ questions: readTrainerQuestions(), config: readTrainerConfig() });
});

app.post('/api/trainer/config', (req, res) => {
  if (!fs.existsSync(TRAINER_DIR)) fs.mkdirSync(TRAINER_DIR, { recursive: true });
  const existing = readTrainerConfig() || {};
  const updated = { ...existing, ...req.body };
  fs.writeFileSync(TRAINER_CONFIG_FILE, JSON.stringify(updated, null, 2));
  res.json({ success: true, config: updated });
});

// Save a draft answer without evaluating.
app.post('/api/trainer/answer', feedbackRoute((req, res) => {
  const { id, answer, expectedRevision } = req.body;
  if (!safeId(id) || typeof answer !== 'string') return res.status(400).json({ error: 'Valid id and answer required' });
  const questions = readTrainerQuestions();
  const q = questions.find(x => x.id === id);
  if (!q) return res.status(404).json({ error: 'question not found' });
  if (expectedRevision !== undefined && expectedRevision !== (q.draftRevision || 0)) return res.status(409).json({ error: 'This answer changed on another device. Reload before saving.', question: q });
  q.draft = answer;
  q.draftRevision = (q.draftRevision || 0) + 1;
  writeTrainerQuestions(questions);
  res.json({ success: true, question: q, revision: q.draftRevision });
}));

app.post('/api/trainer/skip', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const questions = readTrainerQuestions();
  const q = questions.find(x => x.id === id);
  if (!q) return res.status(404).json({ error: 'question not found' });
  q.status = 'skipped';
  writeTrainerQuestions(questions);
  res.json({ success: true });
});

app.post('/api/trainer/evaluate', feedbackRoute((req, res) => res.status(202).json(feedbackService.submit('trainer', req.body))));

// Trigger an on-demand question generation (same script the hourly schedule runs).
app.post('/api/trainer/generate-now', (req, res) => {
  const runner = path.join(expandHome(runtimeState.binDir), 'run-interview-trainer.sh');
  if (!fs.existsSync(runner)) return res.status(404).json({ error: 'run-interview-trainer.sh not installed' });
  const before = readTrainerQuestions().length;
  const { exec } = require('child_process');
  exec(`bash "${runner}" --force`, {
    encoding: 'utf-8',
    timeout: 180000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: os.homedir() },
  }, (err) => {
    const questions = readTrainerQuestions();
    if (err && questions.length <= before) {
      console.error(`Trainer generate-now failed: ${err.message?.slice(0, 200)}`);
      return res.json({ error: true, message: 'Question generation failed. Check logs/interview-trainer.log.' });
    }
    res.json({ success: true, questions });
  });
});

// --- Activity Calendar ---
app.get('/api/activity', (req, res) => {
  const activity = {};
  const addDay = (date) => { if (!activity[date]) activity[date] = { tasksCompleted: 0, tasksTotal: 0, problemsSolved: [], quizAnswered: 0, quizCorrect: 0, events: [] }; };

  // Tasks
  const allTasks = readDataDir('tasks');
  allTasks.forEach(day => {
    if (!day.date || !day.tasks) return;
    addDay(day.date);
    activity[day.date].tasksTotal = day.tasks.length;
    activity[day.date].tasksCompleted = day.tasks.filter(t => t.completed).length;
  });

  // Quiz results
  const progressFile = path.join(DATA_DIR, 'progress.json');
  if (fs.existsSync(progressFile)) {
    const progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    if (progress.quizResults) {
      Object.entries(progress.quizResults).forEach(([date, answers]) => {
        addDay(date);
        activity[date].quizAnswered = answers.length;
        activity[date].quizCorrect = answers.filter(a => a.isCorrect).length;
      });
    }
  }

  // Problems solved
  const probProgressFile = path.join(DATA_DIR, 'problems', 'progress.json');
  if (fs.existsSync(probProgressFile)) {
    const probProgress = JSON.parse(fs.readFileSync(probProgressFile, 'utf-8'));
    if (probProgress.solved) {
      Object.entries(probProgress.solved).forEach(([problemId, data]) => {
        if (data.solvedAt) {
          const date = data.solvedAt.split('T')[0];
          addDay(date);
          activity[date].problemsSolved.push(problemId);
        }
      });
    }
  }

  // Merge daily event journal
  const journal = readActivity();
  Object.entries(journal).forEach(([date, dayData]) => {
    addDay(date);
    activity[date].events = dayData.events || [];
  });

  res.json(activity);
});

// --- Problems / Code Lab ---

const problemStore = createProblemStore(DATA_DIR);
require('./lib/codelab/drafts').registerDraftRoutes(app, {dataDir:DATA_DIR,getProblems:()=>problemStore.read()});
require('./lib/opportunities/routes').registerOpportunityRoutes(app, { dataDir: DATA_DIR, briefPath: process.env.JOB_QUEST_CAREER_BRIEF, queuePath: process.env.JOB_QUEST_REPLY_QUEUE });
require('./lib/learning/routes').registerLearningRoutes(app, {dataDir: DATA_DIR, getProblems: () => problemStore.read()});
app.get('/api/problems', (req, res) => {
  try { res.json(problemStore.read()); } catch (err) { res.status(500).json({ error: `could not read problems: ${err.message}` }); }
});

app.get('/api/problems/progress', (req, res) => {
  const file = path.join(DATA_DIR, 'problems', 'progress.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } else {
    res.json({ solved: {}, bookmarked: [], savedCode: {} });
  }
});

app.post('/api/problems/progress', (req, res) => {
  const body=req.body;
  if(!body||typeof body!=='object'||Array.isArray(body))return res.status(400).json({error:'Progress must be an object'});
  if(Object.hasOwn(body,'savedCode')||Object.hasOwn(body,'draftRevisions'))return res.status(409).json({error:'Save code through the per-problem draft endpoint; refresh this page to preserve newer drafts.'});
  if(Object.keys(body).some(k=>!['solved','bookmarked'].includes(k)))return res.status(400).json({error:'Only solved state or bookmarks can be updated here'});
  if(body.solved!==undefined&&(!body.solved||typeof body.solved!=='object'||Array.isArray(body.solved)))return res.status(400).json({error:'Solved state must be an object'});
  if(body.bookmarked!==undefined&&(!Array.isArray(body.bookmarked)||body.bookmarked.some(id=>typeof id!=='string')))return res.status(400).json({error:'Bookmarks must be a list of problem ids'});
  try{
    const file=path.join(DATA_DIR,'problems','progress.json');
    const prev=require('./lib/codelab/drafts').readProgress(DATA_DIR);
    const allowed=new Set(problemStore.read().problems.map(p=>p.id));
    for(const [id,value] of Object.entries(body.solved||{}))if(!safeId(id)||!allowed.has(id)||!value||typeof value!=='object'||Array.isArray(value)||!Number.isFinite(value.attempts)||value.attempts<0||typeof value.solvedAt!=='string'||Number.isNaN(Date.parse(value.solvedAt)))return res.status(400).json({error:'Solved entries require a known problem, attempts and solvedAt'});
    const solved={...(prev.solved||{})};
    for(const [id,value] of Object.entries(body.solved||{}))solved[id]={...value,solvedAt:solved[id]?.solvedAt||value.solvedAt,attempts:Math.max(solved[id]?.attempts||0,value.attempts)};
    const newlySolved=Object.keys(body.solved||{}).filter(id=>!prev.solved?.[id]);
    const next={...prev,...body,solved,savedCode:prev.savedCode||{},draftRevisions:prev.draftRevisions||{}};
    writeFeedbackJson(file,next);
    if(newlySolved.length){logActivity('problem_solved',{problems:newlySolved});newlySolved.forEach(problemId=>autoCompleteDailyTask(task=>task.category==='coding'&&task.problemId===problemId));}
    res.json({success:true,progress:next});
  }catch(error){res.status(500).json({error:'Could not save progress. Existing drafts were preserved.'});}
});

// Run Python code against test cases (Code Lab and drill verification share lib/codelab/runner.js).
app.post('/api/run-code', (req, res) => {
  const { code, functionName, testCases, adapters } = req.body || {};
  const bad = adaptersError(adapters);
  if (bad) return res.status(400).json({ error: bad, errorSource: 'runtime', errorTitle: 'Invalid problem', results: [] });
  res.json(runPythonTests(code, functionName, testCases, { adapters }));
});

// Add verified drills to Code Lab (each with a reference solution that must pass its tests).
app.post('/api/problems', (req, res) => {
  try {
    const result = addProblems(DATA_DIR, req.body, { runTests: runPythonTests, lint: lintProblems });
    problemStore.invalidate();
    logActivity('problems_added', { problems: result.added });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.code === 'INPUT' ? 400 : 500).json({ error: err.message });
  }
});

// Runtime-backed code review via CLI
const conversations = Object.create(null);
const CONV_DIR = path.join(DATA_DIR, 'conversations');

app.post('/api/code-review', async (req, res) => {
  const { problemId, problemTitle, problemDescription, code, conversationId, userMessage } = req.body;

  if (!validConversationId(conversationId)) return res.status(400).json({ error: 'Invalid conversation id' });
  const convId = conversationId || crypto.randomUUID();
  // Load conversation from file if exists
  if (!conversations[convId]) {
    const convFile = path.join(CONV_DIR, `${convId}.json`);
    if (fs.existsSync(convFile)) {
      conversations[convId] = JSON.parse(fs.readFileSync(convFile, 'utf-8'));
    } else {
      conversations[convId] = [];
    }
  }

  const systemContext = `You are a coding mentor for ${targetLevel(DATA_DIR)} interview prep. The student is working on: "${problemTitle}"

Problem: ${problemDescription}`;

  let prompt;
  if (conversations[convId].length === 0) {
    prompt = `${systemContext}

Their code:
\`\`\`python
${code}
\`\`\`

Review their code and provide:
1. **Closeness Score (0-100%)** — How close is this to the optimal/perfect solution? Consider correctness, time complexity, space complexity, and code quality.
2. **Edge Cases** — List specific edge cases and whether their code handles each one (✅ handled / ❌ missing). Think about: empty inputs, single elements, duplicates, negative numbers, large inputs, boundary conditions.
3. **What's Working** — Brief praise for what they did right.
4. **Improvements** — Guide them toward the optimal solution without giving the answer. Use leading questions.
5. **Complexity** — State current time/space complexity and what optimal would be.

Be concise and encouraging. Format with markdown.`;
  } else {
    // Build context with problem info + recent conversation history so the active runtime remembers what we're working on
    const recentHistory = conversations[convId].slice(-6).map(m => `${m.role === 'user' ? 'Student' : 'Mentor'}: ${m.content}`).join('\n\n');
    const followUpMessage = userMessage || `Here is my updated code:\n\`\`\`python\n${code}\n\`\`\`\n\nWhat do you think?`;
    prompt = `${systemContext}

Their current code:
\`\`\`python
${code}
\`\`\`

Here is the recent conversation for context:
${recentHistory}

Student's new message: ${followUpMessage}

Continue mentoring. Be concise and encouraging. Format with markdown.`;
  }

  conversations[convId].push({ role: 'user', content: prompt });

  const tmpPrompt = path.join(os.tmpdir(), `job_quest_prompt_${Date.now()}.txt`);
  fs.writeFileSync(tmpPrompt, prompt);
  const scriptPath = path.join(__dirname, 'scripts', 'code-review.sh');
  const nvmBin = path.join(os.homedir(), '.nvm/versions/node/v22.12.0/bin');

  const { exec: execAsync } = require('child_process');
  execAsync(`cat "${tmpPrompt}" | bash "${scriptPath}"`, {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: os.homedir(), PATH: `${nvmBin}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
  }, (err, stdout) => {
    try { fs.unlinkSync(tmpPrompt); } catch {}
    if (err) {
      res.json({
        response: `${runtimeDisplayName} is not available. Check that \`${runtimeCommandLabel}\` is installed and on PATH.`,
        conversationId: convId,
        history: conversations[convId],
        error: true,
      });
    } else {
      const result = stdout.trim();
      conversations[convId].push({ role: 'assistant', content: result });
      if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });
      fs.writeFileSync(path.join(CONV_DIR, `${convId}.json`), JSON.stringify(conversations[convId], null, 2));
      logActivity('code_review', { problemId, problemTitle, conversationId: convId });
      res.json({ response: result, conversationId: convId, history: conversations[convId] });
    }
  });
});

// --- System Design Mock Interview ---
const sdConversations = {};
const SD_CONV_DIR = path.join(DATA_DIR, 'sd-conversations');

const SD_TOPICS = [
  { id: 'url-shortener', title: 'Design a URL Shortener', description: 'Design a service like bit.ly that shortens long URLs and redirects users.' },
  { id: 'news-feed', title: 'Design a News Feed', description: 'Design the news feed system for a social network like Facebook or Twitter.' },
  { id: 'chat-system', title: 'Design a Chat System', description: 'Design a real-time messaging system like Slack or WhatsApp.' },
  { id: 'rate-limiter', title: 'Design a Rate Limiter', description: 'Design a rate limiting service that prevents abuse of APIs.' },
  { id: 'notification-system', title: 'Design a Notification System', description: 'Design a system that sends push, email, and SMS notifications at scale.' },
  { id: 'video-streaming', title: 'Design a Video Streaming Platform', description: 'Design a system like YouTube or Netflix for streaming video content.' },
  { id: 'search-engine', title: 'Design a Search Engine', description: 'Design a web-scale search engine like Google.' },
  { id: 'ride-sharing', title: 'Design a Ride Sharing Service', description: 'Design a system like Uber or Lyft for matching riders with drivers in real-time.' },
  { id: 'distributed-cache', title: 'Design a Distributed Cache', description: 'Design a distributed caching system like Memcached or Redis.' },
  { id: 'file-storage', title: 'Design a File Storage System', description: 'Design a cloud file storage service like Google Drive or Dropbox.' },
  { id: 'e-commerce', title: 'Design an E-Commerce Platform', description: 'Design the backend for an e-commerce site handling products, carts, orders, and payments.' },
  { id: 'social-graph', title: 'Design a Social Graph', description: 'Design the social graph and friend recommendation system for a social network.' },
];

function getSafeSdTopicId(topicId) {
  if (typeof topicId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(topicId)) return null;
  return topicId;
}

function getSdConversationFile(topicId) {
  const safeTopicId = getSafeSdTopicId(topicId);
  if (!safeTopicId) return null;
  return path.join(SD_CONV_DIR, `${safeTopicId}.json`);
}

function getSdTopic(topicId) {
  return SD_TOPICS.find(t => t.id === topicId) || getWorkbookSdTopics(DATA_DIR).find(t => t.id === topicId);
}

app.get('/api/sd-topics', (req, res) => {
  const topics = [...SD_TOPICS, ...getWorkbookSdTopics(DATA_DIR)].map(t => {
    const convFile = getSdConversationFile(t.id);
    const hasConversation = fs.existsSync(convFile);
    return { ...t, hasConversation };
  });
  res.json(topics);
});

app.get('/api/sd-conversation/:topicId', (req, res) => {
  const { topicId } = req.params;
  const convFile = getSdConversationFile(topicId);
  if (!convFile) return res.status(400).json({ error: 'Invalid topic id' });
  if (fs.existsSync(convFile)) {
    res.json(JSON.parse(fs.readFileSync(convFile, 'utf-8')));
  } else {
    res.json({ messages: [] });
  }
});

app.post('/api/sd-conversation/:topicId', (req, res) => {
  const { topicId } = req.params;
  const { userMessage } = req.body;
  const topic = getSdTopic(topicId);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });

  const convFile = getSdConversationFile(topicId);
  if (!convFile) return res.status(400).json({ error: 'Invalid topic id' });
  if (!fs.existsSync(SD_CONV_DIR)) fs.mkdirSync(SD_CONV_DIR, { recursive: true });

  let conv = { messages: [] };
  if (fs.existsSync(convFile)) {
    conv = JSON.parse(fs.readFileSync(convFile, 'utf-8'));
  }

  const isFirstMessage = conv.messages.length === 0;

  let prompt;
  if (isFirstMessage) {
    const prepContext = topic.source === 'workbook' ? `
This prompt comes from the study workbook for ${topic.sourceRole || 'a role'}${topic.sourceCompany ? ` at ${topic.sourceCompany}` : ''}.
Interviewer-only focus areas: ${(topic.keyTopics || []).join(', ') || `Use system design coverage appropriate for ${targetLevel(DATA_DIR)}.`}
Evaluation criteria: ${(topic.evaluationCriteria || []).join(', ') || 'Assess requirements, architecture, data model, scalability, tradeoffs, and communication.'}
` : '';
    prompt = `You are a senior staff engineer conducting a system design mock interview. You are warm but rigorous — like a real interviewer at a top tech company (Google, Meta, etc).

The candidate has chosen to design: "${topic.title}"
Topic: ${topic.description}
${prepContext}

Start the interview naturally:
1. Greet the candidate briefly
2. Present the problem clearly
3. Ask them to start by clarifying requirements — what questions would they ask?

IMPORTANT RULES for the entire conversation:
- Act as the interviewer, NOT a tutor. Ask questions, don't lecture.
- Let the candidate drive. Don't give away the answer.
- When they propose something, probe deeper: "Why that approach?", "What are the tradeoffs?", "How would you handle failure here?"
- Push back on hand-wavy answers. Ask for specifics: numbers, protocols, data models.
- If they get stuck, give a small nudge — not the answer.
- Cover these phases naturally: requirements → high-level design → deep dives → scaling → tradeoffs
- At the end (after 8+ exchanges), give structured feedback with a score.
- Keep responses concise — a real interviewer doesn't write essays.
- Use markdown formatting for clarity.`;
  } else {
    const history = conv.messages.map(m => `${m.role === 'user' ? 'CANDIDATE' : 'INTERVIEWER'}: ${m.content}`).join('\n\n');
    const prepContext = topic.source === 'workbook' ? `
This is a workbook question for ${topic.sourceRole || 'a role'}${topic.sourceCompany ? ` at ${topic.sourceCompany}` : ''}.
Interviewer-only focus areas: ${(topic.keyTopics || []).join(', ') || `Use system design coverage appropriate for ${targetLevel(DATA_DIR)}.`}
Evaluation criteria: ${(topic.evaluationCriteria || []).join(', ') || 'Assess requirements, architecture, data model, scalability, tradeoffs, and communication.'}
` : '';
    prompt = `You are a senior staff engineer conducting a system design mock interview for: "${topic.title}".
${prepContext}

Here is the conversation so far:

${history}

CANDIDATE: ${userMessage}

Continue the interview. Remember:
- You are the interviewer. Ask probing questions, don't lecture.
- Push for specifics: data models, API designs, scaling numbers.
- If the candidate is on track, go deeper. If they're stuck, give a small nudge.
- Keep it conversational and concise.
- If this feels like a natural ending point (8+ exchanges), offer to wrap up with feedback. When giving feedback, include: what went well, what to improve, and a score out of 10.
- Use markdown formatting.`;
  }

  conv.messages.push({ role: 'user', content: userMessage || '[Interview started]', timestamp: new Date().toISOString() });

  const tmpPrompt = path.join(os.tmpdir(), `sd_interview_${Date.now()}.txt`);
  fs.writeFileSync(tmpPrompt, prompt);
  const scriptPath = path.join(__dirname, 'scripts', 'code-review.sh');
  const nvmBin = path.join(os.homedir(), '.nvm/versions/node/v22.12.0/bin');

  const { exec: execAsync } = require('child_process');
  execAsync(`cat "${tmpPrompt}" | bash "${scriptPath}"`, {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: os.homedir(), PATH: `${nvmBin}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
  }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmpPrompt); } catch {}
    if (err) {
      res.json({ response: `Failed to reach ${runtimeDisplayName}. Make sure \`${runtimeCommandLabel}\` is installed.\n\nError: ` + (stderr || err.message || '').slice(0, 200), error: true, messages: conv.messages });
    } else {
      const result = stdout.trim();
      conv.messages.push({ role: 'assistant', content: result, timestamp: new Date().toISOString() });
      fs.writeFileSync(convFile, JSON.stringify(conv, null, 2));
      logActivity('sd_interview', { topicId, exchanges: conv.messages.length });
      // Auto-complete matching daily system-design task after substantive session (8+ exchanges)
      if (conv.messages.length >= 8) {
        const topicTitle = topic.title.toLowerCase();
        autoCompleteDailyTask(task => {
          if (task.category !== 'system-design') return false;
          // Match by checking if the topic keywords appear in the task text
          const taskText = task.text.toLowerCase();
          // Extract key subject from topic title (e.g., "Design a Rate Limiter" → "rate limiter")
          const subject = topicTitle.replace(/^design\s+(a|an)\s+/i, '');
          return taskText.includes(subject);
        });
      }
      res.json({ response: result, messages: conv.messages });
    }
  });
});

app.delete('/api/sd-conversation/:topicId', (req, res) => {
  const { topicId } = req.params;
  const convFile = getSdConversationFile(topicId);
  if (!convFile) return res.status(400).json({ error: 'Invalid topic id' });
  if (fs.existsSync(convFile)) fs.unlinkSync(convFile);
  res.json({ success: true });
});

// --- Job Status Endpoint ---
// Detect the installed daily-intel schedule (launchd on macOS, cron on Linux).
// Returns { installed, mechanism, cron, humanReadable } — never throws.
function detectSchedule() {
  const PLIST_PATH = path.join(os.homedir(), 'Library/LaunchAgents/com.sidequest.job-quest.daily-intel.plist');
  const CRON_MARKER = '# job-quest-daily-intel';

  // launchd (macOS)
  if (fs.existsSync(PLIST_PATH)) {
    try {
      const plist = fs.readFileSync(PLIST_PATH, 'utf-8');
      // StartCalendarInterval → <dict><key>Minute</key><integer>3</integer>... pull first entry's Minute/Hour
      // and collect all Weekday values across entries.
      const entryBlocks = plist.match(/<dict>[\s\S]*?<\/dict>/g) || [];
      let minute = null, hour = null;
      const weekdays = new Set();
      for (const block of entryBlocks) {
        const m = block.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
        const h = block.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
        const w = block.match(/<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/);
        if (m) minute = parseInt(m[1], 10);
        if (h) hour = parseInt(h[1], 10);
        if (w) weekdays.add(parseInt(w[1], 10));
      }
      if (minute != null && hour != null) {
        const dow = weekdays.size === 0 ? '*' : [...weekdays].sort((a, b) => a - b).join(',');
        const cron = `${minute} ${hour} * * ${dow}`;
        return { installed: true, mechanism: 'launchd', cron, humanReadable: cronToHuman(cron) };
      }
    } catch {}
  }

  // crontab (Linux, or --force-cron on macOS)
  try {
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = crontab.split('\n').find((l) => l.includes(CRON_MARKER));
    if (line) {
      const cron = line.trim().split(/\s+/).slice(0, 5).join(' ');
      return { installed: true, mechanism: 'cron', cron, humanReadable: cronToHuman(cron) };
    }
  } catch {}

  return { installed: false, mechanism: null, cron: null, humanReadable: null };
}

// Convert a 5-field cron expression to a human-readable schedule.
// Handles the patterns install-schedule.sh supports; falls back to raw cron otherwise.
function cronToHuman(cron) {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mon, dow] = parts;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h) || dom !== '*' || mon !== '*') return cron;

  const hour12 = ((parseInt(h, 10) + 11) % 12) + 1;
  const ampm = parseInt(h, 10) < 12 ? 'AM' : 'PM';
  const minStr = m.padStart(2, '0');
  const time = `${hour12}:${minStr} ${ampm}`;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let dayDesc;
  if (dow === '*') {
    dayDesc = 'daily';
  } else {
    // Normalize any dow spec (e.g. '1-5', '1,2,3,4,5') to a sorted unique set of day integers.
    const days = new Set();
    for (const chunk of dow.split(',')) {
      if (chunk.includes('-')) {
        const [lo, hi] = chunk.split('-').map((x) => parseInt(x, 10));
        if (!isNaN(lo) && !isNaN(hi)) for (let d = lo; d <= hi; d++) days.add(d % 7);
      } else {
        const d = parseInt(chunk, 10);
        if (!isNaN(d)) days.add(d % 7);
      }
    }
    const sorted = [...days].sort((a, b) => a - b).join(',');
    if (sorted === '1,2,3,4,5') dayDesc = 'weekdays';
    else if (sorted === '0,6') dayDesc = 'weekends';
    else if (sorted === '0,1,2,3,4,5,6') dayDesc = 'daily';
    else dayDesc = sorted.split(',').map((d) => dayNames[parseInt(d, 10)]).join(', ');
  }

  return `${time} ${dayDesc}`;
}

app.get('/api/job-status', (req, res) => {
  const today = getLocalDateStamp();
  const intelFile = path.join(DATA_DIR, 'intel', `${today}.json`);
  const quizFile = path.join(DATA_DIR, 'quizzes', `${today}.json`);
  const tasksFile = path.join(DATA_DIR, 'tasks', `${today}.json`);

  const intelExists = fs.existsSync(intelFile);
  const quizExists = fs.existsSync(quizFile);
  const tasksExists = fs.existsSync(tasksFile);

  let rolesCount = 0, questionsCount = 0, tasksCount = 0;
  if (intelExists) {
    try { const d = JSON.parse(fs.readFileSync(intelFile, 'utf-8')); rolesCount = d.roles?.length || 0; } catch {}
  }
  if (quizExists) {
    try { const d = JSON.parse(fs.readFileSync(quizFile, 'utf-8')); questionsCount = d.questions?.length || 0; } catch {}
  }
  if (tasksExists) {
    try { const d = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')); tasksCount = d.tasks?.length || 0; } catch {}
  }

  const allReady = intelExists && quizExists && tasksExists;
  const noneReady = !intelExists && !quizExists && !tasksExists;
  const baseStatus = allReady ? 'success' : noneReady ? 'pending' : 'partial';

  const schedule = detectSchedule();
  // If the user hasn't installed a schedule, surface it as a warning state — the daily agent will never fire.
  const status = !schedule.installed && noneReady ? 'not_scheduled' : baseStatus;

  res.json({
    date: today,
    status,
    intel: { ready: intelExists, roles: rolesCount },
    quiz: { ready: quizExists, questions: questionsCount },
    tasks: { ready: tasksExists, count: tasksCount },
    schedule,
    runtime: {
      displayName: runtimeDisplayName,
      command: runtimeCommandLabel,
    },
    installScheduleCommand,
  });
});

// --- Resume File Upload ---
const RESUME_DIR = path.join(DATA_DIR, 'resume-files');

function safeResumePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  const resolved = path.resolve(RESUME_DIR, name);
  return resolved.startsWith(path.resolve(RESUME_DIR) + path.sep) ? resolved : null;
}

app.post('/api/resume/upload', (req, res) => {
  // Expects base64-encoded file data
  const { filename, data, type } = req.body;
  if (!filename || !data) return res.status(400).json({ error: 'Missing filename or data' });
  if (!fs.existsSync(RESUME_DIR)) fs.mkdirSync(RESUME_DIR, { recursive: true });
  const buffer = Buffer.from(data, 'base64');
  const filepath = safeResumePath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid resume path' });
  fs.writeFileSync(filepath, buffer);
  logActivity('resume_file_upload', { filename, type, size: buffer.length });
  res.json({ success: true, filename, size: buffer.length });
});

// Upload a ZIP file containing LaTeX resume files — extracts and saves all supported files
app.post('/api/resume/upload-zip', (req, res) => {
  const { data, filename } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing zip data' });
  if (!fs.existsSync(RESUME_DIR)) fs.mkdirSync(RESUME_DIR, { recursive: true });

  try {
    const buffer = Buffer.from(data, 'base64');
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (entries.some(entry => !entry.isDirectory && !safeResumePath(entry.entryName))) {
      return res.status(400).json({ error: 'Invalid resume path' });
    }
    const ALLOWED_EXT = ['.tex', '.cls', '.sty', '.bst', '.bib', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.ttf', '.otf'];
    const SKIP_DIRS = ['__MACOSX', '.git', 'node_modules'];
    const uploaded = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName;
      // Skip hidden/system directories
      if (SKIP_DIRS.some(d => entryName.includes(d + '/'))) continue;
      if (entryName.startsWith('.') || entryName.includes('/.')) continue;

      const ext = path.extname(entryName).toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) continue;

      // Flatten: strip any top-level folder if all files share one
      // Keep relative paths for subfolder structure (e.g., images/photo.png)
      const parts = entryName.split('/');
      // Remove single top-level wrapper folder if it exists
      let relativePath = entryName;
      if (entries.filter(e => !e.isDirectory).length > 1) {
        const topDirs = new Set(entries.filter(e => !e.isDirectory).map(e => e.entryName.split('/')[0]));
        if (topDirs.size === 1 && parts.length > 1) {
          relativePath = parts.slice(1).join('/');
        }
      }

      // Create subdirectories if needed
      const targetPath = safeResumePath(relativePath);
      if (!targetPath) return res.status(400).json({ error: 'Invalid resume path' });
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      fs.writeFileSync(targetPath, entry.getData());
      uploaded.push({ name: relativePath, size: entry.getData().length });
    }

    logActivity('resume_zip_upload', { zipFilename: filename, filesExtracted: uploaded.length });
    res.json({ success: true, files: uploaded, count: uploaded.length });
  } catch (err) {
    console.error('ZIP extraction error:', err.message);
    res.status(500).json({ error: 'Failed to extract ZIP file: ' + err.message });
  }
});

// Upload multiple files with relative paths (folder upload)
app.post('/api/resume/upload-folder', (req, res) => {
  const { files } = req.body;
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }
  if (!fs.existsSync(RESUME_DIR)) fs.mkdirSync(RESUME_DIR, { recursive: true });

  const ALLOWED_EXT = ['.tex', '.cls', '.sty', '.bst', '.bib', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.ttf', '.otf'];
  const uploaded = [];

  // Detect common top-level folder prefix to strip
  const paths = files.map(f => f.relativePath || f.filename);
  if (paths.some(name => !safeResumePath(name))) {
    return res.status(400).json({ error: 'Invalid resume path' });
  }
  const topDirs = new Set(paths.map(p => p.split('/')[0]));
  const stripPrefix = topDirs.size === 1 && paths[0].includes('/') ? paths[0].split('/')[0] + '/' : '';

  for (const file of files) {
    const ext = path.extname(file.filename).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) continue;

    let relativePath = file.relativePath || file.filename;
    // Strip common top-level folder
    if (stripPrefix && relativePath.startsWith(stripPrefix)) {
      relativePath = relativePath.slice(stripPrefix.length);
    }
    // Skip hidden files
    if (relativePath.startsWith('.') || relativePath.includes('/.')) continue;

    const targetPath = safeResumePath(relativePath);
    if (!targetPath) return res.status(400).json({ error: 'Invalid resume path' });
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const buffer = Buffer.from(file.data, 'base64');
    fs.writeFileSync(targetPath, buffer);
    uploaded.push({ name: relativePath, size: buffer.length });
  }

  logActivity('resume_folder_upload', { filesUploaded: uploaded.length });
  res.json({ success: true, files: uploaded, count: uploaded.length });
});

app.get('/api/resume/files', (req, res) => {
  if (!fs.existsSync(RESUME_DIR)) return res.json({ files: [] });
  // Recursively list all files
  const results = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const relativeName = prefix ? prefix + '/' + entry : entry;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, relativeName);
      } else {
        results.push({ name: relativeName, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
  };
  walk(RESUME_DIR, '');
  res.json({ files: results });
});

// Support path segments for files in subdirectories (e.g., /api/resume/file/images/photo.png)
app.get('/api/resume/file/{*filepath}', (req, res) => {
  const filename = Array.isArray(req.params.filepath) ? req.params.filepath.join('/') : req.params.filepath;
  const filepath = safeResumePath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid resume path' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  if (!fs.statSync(filepath).isFile()) return res.status(404).json({ error: 'Not a file' });
  // Send relative to RESUME_DIR: an absolute path would make `send` treat the
  // whole chain as a dotfile (DATA_DIR lives under ~/.job-quest) and 404 everything.
  res.sendFile(filename, { root: RESUME_DIR }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).json({ error: 'Could not read file' });
  });
});

// Save file content (direct editor save)
app.post('/api/resume/save-file', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || content === undefined) return res.status(400).json({ error: 'Missing filename or content' });
  const filepath = safeResumePath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid resume path' });
  // Create parent dirs if needed
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  logActivity('resume_file_save', { filename, size: content.length });
  res.json({ success: true, size: content.length });
});

// Create new file
app.post('/api/resume/create-file', (req, res) => {
  const { filename, content } = req.body;
  if (!filename) return res.status(400).json({ error: 'Missing filename' });
  const filepath = safeResumePath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid resume path' });
  if (fs.existsSync(filepath)) return res.status(409).json({ error: 'File already exists' });
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, content || '', 'utf-8');
  logActivity('resume_file_create', { filename });
  res.json({ success: true });
});

// Compile LaTeX to PDF using tectonic
app.post('/api/resume/compile', (req, res) => {
  const { mainFile } = req.body;
  const texFile = mainFile || 'main.tex';
  const filepath = safeResumePath(texFile);
  if (!filepath) return res.status(400).json({ error: 'Invalid resume path' });

  if (!fs.existsSync(filepath)) {
    // Try to find a .tex file that contains \documentclass
    let found = null;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (entry.endsWith('.tex')) {
          try {
            const content = fs.readFileSync(full, 'utf-8');
            if (content.includes('\\documentclass')) { found = full; return; }
          } catch {}
        }
      }
    };
    if (fs.existsSync(RESUME_DIR)) walk(RESUME_DIR);
    if (!found) return res.status(404).json({ error: 'No main .tex file found. Upload a file containing \\documentclass.' });
    // Use the found file
    return doCompile(found, res);
  }
  doCompile(filepath, res);
});

function doCompile(filepath, res) {
  const dir = path.dirname(filepath);
  const filename = path.basename(filepath);
  const pdfName = filename.replace(/\.tex$/, '.pdf');
  const { exec: execAsync } = require('child_process');

  // Pre-process: patch pdfTeX-only commands for Tectonic (XeTeX) compatibility
  try {
    let texSrc = fs.readFileSync(filepath, 'utf-8');
    let patched = false;

    // Replace \input{glyphtounicode}\n\pdfgentounicode=1 with engine-safe version
    if (texSrc.includes('\\input{glyphtounicode}') || texSrc.includes('\\pdfgentounicode')) {
      texSrc = texSrc.replace(/\\input\{glyphtounicode\}\s*/g, '');
      texSrc = texSrc.replace(/\\pdfgentounicode\s*=\s*1\s*/g, '');
      patched = true;
    }
    // Replace \pdfminorversion, \pdfcompresslevel etc.
    texSrc = texSrc.replace(/\\pdf(minorversion|compresslevel|objcompresslevel)\s*=\s*\d+\s*/g, () => { patched = true; return ''; });

    if (patched) {
      // Write to a temp copy so we don't modify the user's file
      const tmpFile = path.join(RESUME_DIR, '_compile_' + filename);
      fs.writeFileSync(tmpFile, texSrc, 'utf-8');
      filepath = tmpFile;
    }
  } catch (e) { /* ignore preprocessing errors, try compiling as-is */ }

  // Run tectonic with the working directory set to the resume dir
  execAsync(`tectonic "${filepath}" --outdir "${RESUME_DIR}" 2>&1`, {
    encoding: 'utf-8',
    timeout: 120000,
    cwd: RESUME_DIR,
    env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' }
  }, (err, stdout, stderr) => {
    const output = (stdout || '') + (stderr || '');

    // Clean up temp compile file and rename temp PDF to proper name
    const tmpTex = path.join(RESUME_DIR, '_compile_' + filename);
    const tmpPdf = path.join(RESUME_DIR, '_compile_' + pdfName);
    const tmpLog = path.join(RESUME_DIR, '_compile_' + filename.replace(/\.tex$/, '.log'));
    const tmpAux = path.join(RESUME_DIR, '_compile_' + filename.replace(/\.tex$/, '.aux'));
    try { if (fs.existsSync(tmpTex)) fs.unlinkSync(tmpTex); } catch {}
    try { if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog); } catch {}
    try { if (fs.existsSync(tmpAux)) fs.unlinkSync(tmpAux); } catch {}
    // If compiled from temp file, rename the PDF
    if (fs.existsSync(tmpPdf)) {
      const finalPdf = path.join(RESUME_DIR, pdfName);
      try { fs.renameSync(tmpPdf, finalPdf); } catch {}
    }
    // Also clean up .log and .aux from the original
    try { if (fs.existsSync(path.join(RESUME_DIR, filename.replace(/\.tex$/, '.log')))) fs.unlinkSync(path.join(RESUME_DIR, filename.replace(/\.tex$/, '.log'))); } catch {}
    try { if (fs.existsSync(path.join(RESUME_DIR, filename.replace(/\.tex$/, '.aux')))) fs.unlinkSync(path.join(RESUME_DIR, filename.replace(/\.tex$/, '.aux'))); } catch {}

    const pdfPath = path.join(RESUME_DIR, pdfName);
    if (fs.existsSync(pdfPath)) {
      logActivity('resume_compile_success', { filename, pdfSize: fs.statSync(pdfPath).size });
      res.json({ success: true, pdf: pdfName, output: output.substring(0, 500) });
    } else {
      logActivity('resume_compile_fail', { filename, error: output.substring(0, 200) });
      res.status(422).json({ error: 'Compilation failed', output: output.substring(0, 2000) });
    }
  });
}

app.post('/api/resume/edit', (req, res) => {
  const { instruction, filename } = req.body;
  if (!instruction || !filename) return res.status(400).json({ error: 'Missing instruction or filename' });
  const filepath = safeResumePath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid resume path' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

  const prompt = `You are a LaTeX resume editor. The user wants to edit their resume file "${filename}" located at "${filepath}".

INSTRUCTION: ${instruction}

Read the file, make the requested changes, and write the updated file back. Only modify what was requested. Keep the LaTeX formatting intact.`;

  const tmpPrompt = path.join(os.tmpdir(), `resume_edit_${Date.now()}.txt`);
  fs.writeFileSync(tmpPrompt, prompt);
  const scriptPath = path.join(__dirname, 'scripts', 'code-review.sh');
  const nvmBin = path.join(os.homedir(), '.nvm/versions/node/v22.12.0/bin');

  const { exec: execAsync } = require('child_process');
  execAsync(`cat "${tmpPrompt}" | bash "${scriptPath}"`, {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: os.homedir(), PATH: `${nvmBin}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
  }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmpPrompt); } catch {}
    if (err) {
      res.json({ response: `${runtimeDisplayName} is not available for editing. Error: ` + (stderr || err.message || '').slice(0, 200), error: true });
    } else {
      logActivity('resume_edit', { filename, instruction: instruction.substring(0, 100) });
      res.json({ response: stdout.trim(), success: true });
    }
  });
});

app.delete('/api/resume/file/{*filepath}', (req, res) => {
  const filename = Array.isArray(req.params.filepath) ? req.params.filepath.join('/') : req.params.filepath;
  const filepath = safeResumePath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid resume path' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  try {
    fs.unlinkSync(filepath);
    // Clean up empty parent directories
    let dir = path.dirname(filepath);
    while (dir !== RESUME_DIR && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
    logActivity('resume_file_delete', { filename });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete file: ' + err.message });
  }
});

// Write data endpoint (for scheduled task to push data)
app.post('/api/data/:type', (req, res) => {
  const { type } = req.params;
  const { filename, data } = req.body;
  if (!['intel', 'quizzes', 'tasks'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }
  writeData(type, filename, data);
  res.json({ success: true });
});

// --- Resume tailoring (P2) ---
const resumeService = createResumeService({ dataDir: DATA_DIR, queue: jobQueue });
jobHandlers.resume = (job, ctx) => resumeService.runJob(job, ctx);
roleEvents.on('saved', (roleKey) => resumeService.autoTailor(roleKey, 'auto-saved'));
roleEvents.on('applied', (roleKey) => resumeService.autoTailor(roleKey, 'auto-applied'));

function sendResumeError(res, err) {
  if (err && err.validation) return res.status(400).json({ error: 'invalid master resume', errors: err.validation });
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error('[resume]', err);
  return res.status(500).json({ error: String((err && err.message) || err) });
}
const resumeRoute = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { if (!res.headersSent) sendResumeError(res, err); }
};

app.get('/api/resume/master', resumeRoute((req, res) => res.json(readMaster(DATA_DIR))));
app.put('/api/resume/master', resumeRoute((req, res) => {
  const saved = writeMaster(DATA_DIR, req.body || {});
  logActivity('resume_master_update', { roles: saved.experience.reduce((n, e) => n + e.roles.length, 0) });
  res.json(saved);
}));
app.get('/api/resume/tailored', resumeRoute((req, res) => res.json(resumeService.listMeta())));
app.post('/api/resume/tailored', resumeRoute((req, res) => {
  const roleKey = req.body && req.body.roleKey;
  const result = resumeService.requestTailor(roleKey, { trigger: 'manual' });
  if (result.created) logActivity('resume_tailor_requested', { roleKey, id: result.meta.id });
  res.status(result.created ? 201 : 200).json(result);
}));
app.get('/api/resume/tailored/:id', resumeRoute((req, res) => res.json(resumeService.getRecord(req.params.id))));
app.put('/api/resume/tailored/:id/jd', resumeRoute((req, res) => res.json(resumeService.setJd(req.params.id, req.body && req.body.text))));
app.post('/api/resume/tailored/:id/retry', resumeRoute((req, res) => res.json(resumeService.retry(req.params.id))));
app.post('/api/resume/tailored/:id/accept', resumeRoute((req, res) => {
  const meta = resumeService.accept(req.params.id);
  logActivity('resume_tailored_accepted', { id: meta.id, score: meta.bestScore });
  res.json(meta);
}));
app.get('/api/resume/tailored/:id/pdf', resumeRoute((req, res) => {
  const file = resumeService.pdfPath(req.params.id, req.query.round);
  // Relative path + root: `send` 404s absolute paths that pass through a dot directory (~/.job-quest).
  res.sendFile(path.relative(resumeService.tailoredDir, file), { root: resumeService.tailoredDir }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).json({ error: 'could not read PDF' });
  });
}));
app.get('/api/resume/tailored/:id/diff', resumeRoute((req, res) => res.json(resumeService.diff(req.params.id))));
app.delete('/api/resume/tailored/:id', resumeRoute((req, res) => {
  resumeService.remove(req.params.id);
  res.json({ success: true });
}));

app.post('/api/resume/master/import-latex', resumeRoute(async (req, res) => {
  const name = (req.body && req.body.filename) || 'resume_cv.tex';
  const file = path.resolve(RESUME_DIR, name);
  if (!file.startsWith(path.resolve(RESUME_DIR) + path.sep)) return res.status(403).json({ error: 'Access denied' });
  const result = await resumeService.importLatex(file);
  logActivity('resume_master_import_proposed', { filename: name, errors: result.errors.length });
  return res.json(result);
}));

// Migrate and check Code Lab problems at startup so the log shows any that need attention.
try { problemStore.read(); } catch (err) { console.error(`[codelab] ${err.message}`); }

feedbackService.recover();
jobQueue.start();
jobQueue.tick();
setInterval(() => { jobQueue.tick(); }, 60000).unref();

startInterviewScanner({ dataDir: DATA_DIR, interviewHome: INTERVIEW_HOME });

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Job Hunt Command Center running at:\n`);
  console.log(`  http://localhost:${PORT}\n`);
});
