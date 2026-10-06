// app/lib/interview/analysis.js
// Agent: analyze a debrief into asked questions, weak spots, follow-ups. Code: validate, retry once, drop the rest.
const fs = require('fs');
const path = require('path');
const { runAgent } = require('../jobs/runner');
const { getLocalDateStamp } = require('../local-date');
const { renderPrompt } = require('./prompts');
const markup = require('./workbook-markup');
const bridge = require('./workbook-bridge');
const { isValidDate } = require('./task-effects');
const { assertFolderName } = require('./contract');

const ANALYST_AGENT = 'debrief-analyst';
const OUT_FILE = 'analysis.json';
const GRADES = ['got', 'partial', 'missed'];
const TYPES = ['open', 'code'];
const DEFAULT_TOPICS = ['Coding', 'System design', 'Behavioral'];
const MAX_ITEMS = 100;
const LIMITS = { title: 240, topic: 120, prompt: 20000, rubric: 20000, answer: 20000, evidence: 2000, label: 500, text: 2000 };

function sessionWorkDir(dataDir, folder) {
  return path.join(dataDir, 'interview-work', 'sessions', assertFolderName(folder));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

function transcriptTail(sessionDir, maxChars = 20000) {
  const out = [];
  for (const raw of readText(path.join(sessionDir, 'transcript.jsonl')).split('\n')) {
    if (!raw.trim()) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (!ev || !['interviewer', 'you', 'clipboard'].includes(ev.speaker)) continue;
    out.push(`${String(ev.speaker).toUpperCase()}: ${String(ev.text || '').replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  }
  const text = out.join('\n');
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Diagnostics can quote agent text; bound it and keep it within the prompt's data section.
const diagnosticValue = (v) => JSON.stringify(typeof v === 'string' ? v.slice(0, 120) : v)?.slice(0, 160);

function validateAnalysis(raw, { folder, round, date, knownTopics = [] }) {
  const errors = [];
  const dropped = [];
  if (!isObject(raw) || !['asked', 'weakSpots', 'followUps'].every((k) => Array.isArray(raw[k]))) {
    return { analysis: null, errors: ['analysis.json must be a JSON object with asked, weakSpots, followUps'], dropped };
  }
  const drop = (kind, index, reason, label) => { errors.push(`${label}[${index}]: ${reason}`); dropped.push({ kind, index, reason }); };

  const asked = [];
  const kept = new Map();
  raw.asked.forEach((a, i) => {
    if (i >= MAX_ITEMS) { drop('asked', i, `exceeds ${MAX_ITEMS} items`, 'asked'); return; }
    const why = [];
    if (!isObject(a)) why.push('not an object');
    else {
      for (const k of ['title', 'prompt', 'topic', 'rubric', 'answer']) if (!nonEmpty(a[k])) why.push(`missing ${k}`);
      if (!TYPES.includes(a.type)) why.push(`type must be open or code, got ${diagnosticValue(a.type)}`);
      if (![1, 2, 3].includes(a.diff)) why.push('diff must be 1, 2, or 3');
      if (!GRADES.includes(a.grade)) why.push('grade must be got, partial, or missed');
      if (typeof a.evidence !== 'string') why.push('missing evidence');
      for (const k of ['title', 'prompt', 'topic', 'rubric', 'answer', 'evidence']) {
        if (typeof a[k] === 'string' && a[k].length > LIMITS[k]) why.push(`${k} exceeds ${LIMITS[k]} characters`);
      }
    }
    if (!why.length) {
      const item = {
        title: a.title.trim(), prompt: a.prompt.trim(), type: a.type, topic: a.topic.trim(), diff: a.diff,
        rubric: a.rubric.trim(), answer: a.answer.trim(), grade: a.grade, evidence: a.evidence.trim(), verified: false,
      };
      const text = markup.renderChapter({ companySlug: 'check', sessions: [], questions: [{ qid: markup.qidFor(folder, i + 1), item, date, round }] });
      const findings = bridge.lintMarkup(text, `asked-${i + 1}.md`);
      if (!findings.length) { kept.set(i, asked.length); asked.push(item); return; }
      why.push(...findings.map((f) => `lint ${f.rule}: ${f.message}`));
    }
    drop('asked', i, why.join('; '), 'asked');
  });

  const topics = new Set([...DEFAULT_TOPICS, ...knownTopics, ...asked.map((a) => a.topic)].map((t) => String(t).toLowerCase()));
  const weakSpots = [];
  raw.weakSpots.forEach((w, i) => {
    if (i >= MAX_ITEMS) { drop('weakSpot', i, `exceeds ${MAX_ITEMS} items`, 'weakSpots'); return; }
    let why = null;
    if (!isObject(w)) why = 'not an object';
    else if (!nonEmpty(w.label)) why = 'missing label';
    else if (w.label.length > LIMITS.label) why = `label exceeds ${LIMITS.label} characters`;
    else if (typeof w.ref === 'number') { if (!kept.has(w.ref)) why = `ref ${w.ref} is not a kept asked index`; }
    else if (typeof w.ref === 'string') {
      if (w.ref.length > LIMITS.topic) why = `ref exceeds ${LIMITS.topic} characters`;
      else if (!topics.has(w.ref.trim().toLowerCase())) why = `ref ${diagnosticValue(w.ref)} is not a known topic`;
    }
    else why = 'ref must be an asked index or a topic';
    if (why) { drop('weakSpot', i, why, 'weakSpots'); return; }
    weakSpots.push({ label: w.label.trim(), ref: typeof w.ref === 'number' ? kept.get(w.ref) : w.ref.trim() });
  });

  const followUps = [];
  raw.followUps.forEach((f, i) => {
    if (i >= MAX_ITEMS) { drop('followUp', i, `exceeds ${MAX_ITEMS} items`, 'followUps'); return; }
    let why = null;
    if (!isObject(f)) why = 'not an object';
    else if (!nonEmpty(f.text)) why = 'missing text';
    else if (f.text.length > LIMITS.text) why = `text exceeds ${LIMITS.text} characters`;
    else if (f.due !== undefined && f.due !== null && !isValidDate(f.due)) why = `due ${diagnosticValue(f.due)} is not a YYYY-MM-DD date`;
    if (why) { drop('followUp', i, why, 'followUps'); return; }
    followUps.push(f.due ? { text: f.text.trim(), due: f.due } : { text: f.text.trim() });
  });

  return { analysis: { asked, weakSpots, followUps }, errors, dropped };
}

async function analyzeDebrief({ dataDir, sessionDir, parsed, knownTopics = [], timeoutMs = 8 * 60 * 1000, runAgentFn = runAgent }) {
  let dir;
  try { dir = sessionWorkDir(dataDir, parsed.folder); }
  catch (error) { return { analysis: null, dropped: [], error: error.message }; }
  fs.mkdirSync(dir, { recursive: true });
  const date = getLocalDateStamp(new Date(parsed.startedAt));
  const vars = {
    round: parsed.round,
    topics: JSON.stringify([...new Set([...DEFAULT_TOPICS, ...knownTopics])]),
    questions: parsed.questions.map((q) => `- ${q.title}`).join('\n') || '- (none recorded)',
    debrief: String(parsed.debrief || '').slice(0, 40000),
    stages: readText(path.join(sessionDir, 'stages.md')).slice(0, 20000),
    transcriptTail: transcriptTail(sessionDir),
  };
  let errors = [];
  let best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = path.join(dir, OUT_FILE);
    fs.rmSync(out, { force: true });
    const prompt = renderPrompt('debrief-analyst', {
      ...vars,
      errors: JSON.stringify(errors),
    });
    const run = await runAgentFn({ agent: ANALYST_AGENT, prompt, cwd: dir, profile: 'write', timeoutMs, logFile: path.join(dir, 'agent.log') });
    if (!run.ok) { errors = [run.timedOut ? 'the agent timed out' : `the agent exited with code ${run.code}`]; continue; }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(out, 'utf-8')); } catch { errors = [`${OUT_FILE} is missing or not valid JSON`]; continue; }
    const v = validateAnalysis(raw, { folder: parsed.folder, round: parsed.round, date, knownTopics });
    errors = v.errors;
    if (!v.analysis) continue;
    best = v;
    if (!v.errors.length) break;
  }
  if (best) return { analysis: best.analysis, dropped: best.dropped, error: null };
  return { analysis: null, dropped: [], error: errors.join('; ') || 'analysis failed' };
}

module.exports = { ANALYST_AGENT, sessionWorkDir, transcriptTail, validateAnalysis, analyzeDebrief };
