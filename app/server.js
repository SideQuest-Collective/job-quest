const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const AdmZip = require('adm-zip');
const { ensureRuntime, expandHome } = require('../lib/runtime');

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

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  const today = new Date().toISOString().split('T')[0];
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
  const today = new Date().toISOString().split('T')[0];
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
  res.json(all[0] || null);
});

// Get all quizzes
app.get('/api/quizzes', (req, res) => {
  res.json(readDataDir('quizzes'));
});

// Get today's quiz
app.get('/api/quizzes/today', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const all = readDataDir('quizzes');
  const todayQuiz = all.find(q => q.date === today);
  res.json(todayQuiz || all[0] || null);
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
  const today = new Date().toISOString().split('T')[0];
  const all = readDataDir('tasks');
  const todayTasks = all.find(t => t.date === today);
  res.json(todayTasks || all[0] || null);
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
    totalTasks, completedTasks,
    totalQuestions, correctAnswers,
    daysActive: allTasks.length,
    quizDays: Object.keys(progress.quizResults || {}).length,
    streak: calculateStreak(allTasks),
    ...progress
  });
});

function calculateStreak(allTasks) {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 60; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayTasks = allTasks.find(t => t.date === dateStr);
    if (dayTasks && dayTasks.tasks && dayTasks.tasks.some(t => t.completed)) {
      streak++;
    } else if (i > 0) break;
  }
  return streak;
}

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
  const file = path.join(DATA_DIR, 'role-tracker.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  Object.keys(req.body).forEach(key => {
    if (!prev[key]) {
      logActivity('role_tracked', { role: key, stage: req.body[key].stage });
    } else if (prev[key].stage !== req.body[key].stage) {
      logActivity('role_stage_change', { role: key, from: prev[key].stage, to: req.body[key].stage });
    }
  });
  res.json({ success: true });
});

// Generate interview prep plan for a role
app.post('/api/interview-plan', (req, res) => {
  const { roleKey, company, role, level, location, fit, tips, resumeSummary, resumeSkills } = req.body;
  const requestId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  console.log(`[${requestId}] Interview plan generation started for: ${company} | ${role}`);

  const prompt = `You are a Staff/L6 interview coach. Generate a STRUCTURED interview prep package as a single JSON object.

ROLE: ${role} at ${company}
LEVEL: ${level}
LOCATION: ${location}

WHY THIS FITS THE CANDIDATE:
${fit || 'No fit analysis available.'}

INTERVIEW TIPS FROM RESEARCH:
${(tips || []).map(t => `- ${t.text} (Source: ${t.source})`).join('\n') || 'No tips available.'}

CANDIDATE BACKGROUND:
${resumeSummary || 'Senior software engineer preparing for Staff/L6 roles.'}
Skills: ${(resumeSkills || []).join(', ') || 'Not specified'}

CRITICAL: Your entire response must be a single valid JSON object. No text before or after. No code fences. No markdown. Just the JSON object starting with { and ending with }.

The JSON must have this exact structure:

{"technicalQuestions":[{"question":"the interview question","category":"system-design or coding or architecture","difficulty":"medium or hard","type":"text or code","starterCode":"only if type is code - provide Python starter code","testCases":"only if type is code - describe test cases","sampleAnswer":"reference answer for evaluation","followUps":["follow-up question 1","follow-up question 2"]}],"behavioralQuestions":[{"question":"behavioral question","starFramework":{"situation":"what situation to describe","task":"the task","action":"what action to take","result":"expected result"},"whatTheyLookFor":"what interviewers evaluate"}],"quiz":[{"question":"quiz question","options":["A) option","B) option","C) option","D) option"],"correctIndex":0,"explanation":"why this is correct"}],"systemDesignPrompt":{"title":"system name to design","description":"detailed problem statement","keyTopics":["topic1","topic2"],"evaluationCriteria":["criteria1","criteria2"]},"readinessChecklist":[{"item":"checklist item","category":"technical or behavioral or company-research or logistics"}],"companyInsights":{"culture":"description","techStack":"description","interviewProcess":"description","recentNews":"description"}}

REQUIREMENTS:
- Generate exactly 5 technical questions for ${company}'s ${role} role. For coding questions, set type to "code" and provide Python starterCode with function signature and testCases description. For non-coding questions, set type to "text".
- At least 2 technical questions must have type "code" with working Python starter code
- Generate exactly 4 behavioral questions tailored to ${company}'s values
- Generate exactly 8 quiz questions mixing system design, coding concepts, and ${company}-specific knowledge
- System design prompt must be realistic for ${level} at ${company}
- Readiness checklist: 8-10 items across all categories
- All content specific to this role, no generic advice
- All sampleAnswer fields must contain substantive reference answers for evaluation
- REMEMBER: Output ONLY the JSON object. No other text.`;

  const tmpPrompt = path.join(os.tmpdir(), `interview_plan_${Date.now()}.txt`);
  fs.writeFileSync(tmpPrompt, prompt);
  const scriptPath = path.join(__dirname, 'scripts', 'generate-plan.sh');

  console.log(`[${requestId}] Prompt written to: ${tmpPrompt} (${prompt.length} chars)`);
  console.log(`[${requestId}] Script: ${scriptPath}`);

  const { exec } = require('child_process');
  const startTime = Date.now();
  exec(`bash "${scriptPath}" "${tmpPrompt}"`, {
    encoding: 'utf-8',
    timeout: 300000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, HOME: os.homedir() },
  }, (err, stdout, stderr) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    try { fs.unlinkSync(tmpPrompt); } catch {}

    if (err) {
      console.error(`[${requestId}] FAILED after ${elapsed}s`);
      console.error(`[${requestId}] Error: ${err.message?.slice(0, 300)}`);
      console.error(`[${requestId}] stderr: ${(stderr || '').slice(0, 300)}`);
      console.error(`[${requestId}] stdout (first 300): ${(stdout || '').slice(0, 300)}`);
      res.json({ error: true, message: `Plan generation failed after ${elapsed}s.\n\nError: ${(stderr || err.message || '').slice(0, 200)}` });
      return;
    }

    console.log(`[${requestId}] ${runtimeDisplayName} responded in ${elapsed}s (${(stdout || '').length} bytes)`);
    console.log(`[${requestId}] stdout preview: ${(stdout || '').slice(0, 200)}`);
    if (stderr) console.log(`[${requestId}] stderr: ${stderr.slice(0, 200)}`);

    // Try to parse JSON from response - multiple strategies
    let raw = (stdout || '').trim();
    let plan = null;
    let parseError = null;

    // Strategy 1: Direct parse (response is pure JSON)
    try {
      plan = JSON.parse(raw);
    } catch (e) { parseError = e; }

    // Strategy 2: Find JSON code fence
    if (!plan) {
      const jsonFence = raw.match(/```json\s*([\s\S]*?)```/);
      if (jsonFence) {
        console.log(`[${requestId}] Trying JSON code fence extraction`);
        try { plan = JSON.parse(jsonFence[1].trim()); } catch (e) { parseError = e; }
      }
    }

    // Strategy 3: Find the largest { ... } block (the JSON object)
    if (!plan) {
      const jsonStart = raw.indexOf('{"');
      if (jsonStart >= 0) {
        console.log(`[${requestId}] Trying brace extraction from index ${jsonStart}`);
        // Find matching closing brace by counting braces
        let depth = 0;
        let jsonEnd = -1;
        for (let i = jsonStart; i < raw.length; i++) {
          if (raw[i] === '{') depth++;
          else if (raw[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd > jsonStart) {
          const jsonStr = raw.slice(jsonStart, jsonEnd);
          console.log(`[${requestId}] Extracted JSON block: ${jsonStr.length} chars`);
          try { plan = JSON.parse(jsonStr); } catch (e) { parseError = e; }
        }
      }
    }

    if (plan && typeof plan === 'object') {
      const keys = Object.keys(plan);
      console.log(`[${requestId}] SUCCESS: Parsed JSON with keys: ${keys.join(', ')}`);
      logActivity('interview_plan_generated', { role: roleKey });
      res.json({ plan });
    } else {
      console.error(`[${requestId}] All JSON parse strategies failed: ${parseError?.message}`);
      console.error(`[${requestId}] Raw (first 500): ${raw.slice(0, 500)}`);
      if (raw.length > 50) {
        logActivity('interview_plan_generated', { role: roleKey, format: 'markdown' });
        res.json({ plan: null, fallbackMarkdown: stdout.trim() });
      } else {
        console.error(`[${requestId}] Response too short or empty, treating as failure`);
        res.json({ error: true, message: `${runtimeDisplayName} returned empty or invalid output after ${elapsed}s` });
      }
    }
  });
});

// --- Evaluate Practice Answer ---
app.post('/api/evaluate-answer', (req, res) => {
  const { question, userAnswer, sampleAnswer, category } = req.body;
  const requestId = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[${requestId}] Evaluating answer for: ${question?.slice(0, 60)}...`);

  const prompt = `You are a senior technical interviewer evaluating a candidate's answer.

QUESTION: ${question}

CANDIDATE'S ANSWER:
${userAnswer}

REFERENCE ANSWER:
${sampleAnswer}

CATEGORY: ${category}

Evaluate the candidate's answer. Your entire response must be a single JSON object with no other text:
{"score":0,"maxScore":10,"strengths":["strength 1"],"improvements":["area to improve 1"],"feedback":"2-3 sentence overall feedback"}

Score 0-10 where: 0-3=poor, 4-5=needs work, 6-7=good, 8-9=strong, 10=excellent.
Be specific and constructive. Reference the question's domain. Output ONLY the JSON.`;

  const tmpPrompt = path.join(os.tmpdir(), `eval_${Date.now()}.txt`);
  fs.writeFileSync(tmpPrompt, prompt);
  const scriptPath = path.join(__dirname, 'scripts', 'generate-plan.sh');

  const { exec } = require('child_process');
  exec(`bash "${scriptPath}" "${tmpPrompt}"`, {
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: os.homedir() },
  }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmpPrompt); } catch {}
    if (err) {
      console.error(`[${requestId}] Eval failed: ${err.message?.slice(0, 200)}`);
      res.json({ score: 0, maxScore: 10, feedback: 'Evaluation failed. Please try again.', strengths: [], improvements: [] });
      return;
    }
    let raw = (stdout || '').trim();
    // Try parse strategies
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
      console.log(`[${requestId}] Eval success: score=${result.score}/${result.maxScore}`);
      res.json(result);
    } else {
      console.error(`[${requestId}] Eval parse failed, raw: ${raw.slice(0, 300)}`);
      res.json({ score: 0, maxScore: 10, feedback: raw.slice(0, 500), strengths: [], improvements: [] });
    }
  });
});

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

app.post('/api/behavioral/answers', (req, res) => {
  if (!fs.existsSync(BEHAVIORAL_DIR)) fs.mkdirSync(BEHAVIORAL_DIR, { recursive: true });
  const answersFile = path.join(BEHAVIORAL_DIR, 'answers.json');
  const existing = fs.existsSync(answersFile) ? JSON.parse(fs.readFileSync(answersFile, 'utf-8')) : {};
  const { key, answer, evaluation } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  existing[key] = { answer: answer || existing[key]?.answer, evaluation: evaluation || existing[key]?.evaluation, updatedAt: new Date().toISOString() };
  fs.writeFileSync(answersFile, JSON.stringify(existing, null, 2));
  res.json({ success: true });
});

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

  const prompt = `You are a Staff-level interview coach helping a candidate prepare a STAR-format behavioral answer.

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

app.get('/api/problems', (req, res) => {
  const file = path.join(DATA_DIR, 'problems', 'problems.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } else {
    res.json({ categories: [], problems: [] });
  }
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
  const file = path.join(DATA_DIR, 'problems', 'progress.json');
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Detect newly solved problems
  let prev = { solved: {} };
  if (fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const newlySolved = Object.keys(req.body.solved || {}).filter(id => !prev.solved?.[id]);
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  if (newlySolved.length) {
    logActivity('problem_solved', { problems: newlySolved });
    // Auto-complete matching daily tasks
    newlySolved.forEach(problemId => {
      autoCompleteDailyTask(task => task.category === 'coding' && task.problemId === problemId);
    });
  }
  // Log code saves
  const newCode = Object.keys(req.body.savedCode || {}).filter(id => req.body.savedCode[id] !== prev.savedCode?.[id]);
  if (newCode.length) logActivity('code_saved', { problems: newCode });
  res.json({ success: true });
});

// Run Python code against test cases
app.post('/api/run-code', (req, res) => {
  const { code, functionName, testCases } = req.body;
  const tmpFile = path.join(os.tmpdir(), `codelab_${Date.now()}.py`);

  const testRunner = `
import json, sys, traceback

# User code
${code}

# Test runner
tests = ${JSON.stringify(testCases)}
results = []
for i, test in enumerate(tests):
    try:
        result = ${functionName}(**test['input'])
        # Sort lists for order-insensitive comparison where needed
        expected = test['expected']
        passed = result == expected
        # Try sorted comparison for list results
        if not passed and isinstance(result, list) and isinstance(expected, list):
            try:
                passed = sorted(result) == sorted(expected)
            except:
                pass
        results.append({"index": i, "passed": passed, "actual": repr(result), "expected": repr(expected)})
    except Exception as e:
        results.append({"index": i, "passed": False, "error": traceback.format_exc().split("\\n")[-2]})
print(json.dumps(results))
`;

  try {
    fs.writeFileSync(tmpFile, testRunner);
    const output = execSync(`python3 "${tmpFile}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    fs.unlinkSync(tmpFile);
    res.json({ results: JSON.parse(output.trim()) });
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    const stderr = err.stderr || err.message || '';
    // Extract meaningful Python error
    const lines = stderr.split('\n').filter(l => l.trim());
    const errorMsg = lines.length > 0 ? lines[lines.length - 1] : 'Execution failed';
    res.json({ error: errorMsg, results: [] });
  }
});

// Runtime-backed code review via CLI
const conversations = {};
const CONV_DIR = path.join(DATA_DIR, 'conversations');

app.post('/api/code-review', async (req, res) => {
  const { problemId, problemTitle, problemDescription, code, conversationId, userMessage } = req.body;

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

  const systemContext = `You are a coding mentor for Staff/L6 interview prep. The student is working on: "${problemTitle}"

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

app.get('/api/sd-topics', (req, res) => {
  const topics = SD_TOPICS.map(t => {
    const convFile = path.join(SD_CONV_DIR, `${t.id}.json`);
    const hasConversation = fs.existsSync(convFile);
    return { ...t, hasConversation };
  });
  res.json(topics);
});

app.get('/api/sd-conversation/:topicId', (req, res) => {
  const { topicId } = req.params;
  const convFile = path.join(SD_CONV_DIR, `${topicId}.json`);
  if (fs.existsSync(convFile)) {
    res.json(JSON.parse(fs.readFileSync(convFile, 'utf-8')));
  } else {
    res.json({ messages: [] });
  }
});

app.post('/api/sd-conversation/:topicId', (req, res) => {
  const { topicId } = req.params;
  const { userMessage } = req.body;
  const topic = SD_TOPICS.find(t => t.id === topicId);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });

  const convFile = path.join(SD_CONV_DIR, `${topicId}.json`);
  if (!fs.existsSync(SD_CONV_DIR)) fs.mkdirSync(SD_CONV_DIR, { recursive: true });

  let conv = { messages: [] };
  if (fs.existsSync(convFile)) {
    conv = JSON.parse(fs.readFileSync(convFile, 'utf-8'));
  }

  const isFirstMessage = conv.messages.length === 0;

  let prompt;
  if (isFirstMessage) {
    prompt = `You are a senior staff engineer conducting a system design mock interview. You are warm but rigorous — like a real interviewer at a top tech company (Google, Meta, etc).

The candidate has chosen to design: "${topic.title}"
Topic: ${topic.description}

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
    prompt = `You are a senior staff engineer conducting a system design mock interview for: "${topic.title}".

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
  const convFile = path.join(SD_CONV_DIR, `${topicId}.json`);
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
  const today = new Date().toISOString().split('T')[0];
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

app.post('/api/resume/upload', (req, res) => {
  // Expects base64-encoded file data
  const { filename, data, type } = req.body;
  if (!filename || !data) return res.status(400).json({ error: 'Missing filename or data' });
  if (!fs.existsSync(RESUME_DIR)) fs.mkdirSync(RESUME_DIR, { recursive: true });
  const buffer = Buffer.from(data, 'base64');
  const filepath = path.join(RESUME_DIR, filename);
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
      const targetDir = path.join(RESUME_DIR, path.dirname(relativePath));
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      const targetPath = path.join(RESUME_DIR, relativePath);
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

    const targetDir = path.join(RESUME_DIR, path.dirname(relativePath));
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const buffer = Buffer.from(file.data, 'base64');
    fs.writeFileSync(path.join(RESUME_DIR, relativePath), buffer);
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
  const filepath = path.join(RESUME_DIR, filename);
  // Security: ensure resolved path is within RESUME_DIR
  if (!path.resolve(filepath).startsWith(path.resolve(RESUME_DIR))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filepath);
});

// Save file content (direct editor save)
app.post('/api/resume/save-file', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || content === undefined) return res.status(400).json({ error: 'Missing filename or content' });
  const filepath = path.join(RESUME_DIR, filename);
  if (!path.resolve(filepath).startsWith(path.resolve(RESUME_DIR))) {
    return res.status(403).json({ error: 'Access denied' });
  }
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
  const filepath = path.join(RESUME_DIR, filename);
  if (!path.resolve(filepath).startsWith(path.resolve(RESUME_DIR))) {
    return res.status(403).json({ error: 'Access denied' });
  }
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
  const filepath = path.join(RESUME_DIR, texFile);

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
  const filepath = path.join(RESUME_DIR, filename);
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
  const filepath = path.join(RESUME_DIR, filename);
  if (!path.resolve(filepath).startsWith(path.resolve(RESUME_DIR))) {
    return res.status(403).json({ error: 'Access denied' });
  }
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

app.listen(PORT, () => {
  console.log(`\n  Job Hunt Command Center running at:\n`);
  console.log(`  http://localhost:${PORT}\n`);
});
