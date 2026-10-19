// app/lib/podcast/script.js
// The agent writes the two-host script; code validates it and retries once with the errors.
const fs = require('fs');
const path = require('path');
const { runAgent } = require('../jobs/runner');
const { renderPrompt } = require('../interview/prompts');
const { readJson } = require('./store');

const SCRIPT_AGENT = 'podcast-script';
const OUT_FILE = 'script.out.json';
const WORDS_PER_MIN = 155;

function wordTargets(targetMinutes) {
  const mid = targetMinutes * WORDS_PER_MIN;
  return { minWords: Math.round(mid * 0.7), maxWords: Math.round(mid * 1.3) };
}

function countWords(s) { return String(s).trim().split(/\s+/).filter(Boolean).length; }

// Episodes are scenario-first: every concept becomes a question to the listener, silence to think, then the reasoning.
// The validator holds the writer to that shape so it cannot drift back into reading notes aloud.
const CLIPPED_WORDS = 8;
const MAX_INTRO_WORDS = 300;
// He is relearning the fundamentals: long monologues read as a lecture, so lines stay short and the learner host keeps talking.
const MAX_LINE_CHARS = 450;
const MAX_RUN = 3;
const MIN_LEARNER_SHARE = 0.25;
function validateScript(data, { hosts, targetMinutes, concepts = 0, minPauses = Math.max(3, concepts + 1), forbidden = [] }) {
  const errors = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['not a JSON object'] };
  const names = hosts.map((h) => h.name);
  if (typeof data.title !== 'string' || !data.title.trim()) errors.push('missing title');
  if (typeof data.summary !== 'string' || !data.summary.trim()) errors.push('missing summary');
  if (!Array.isArray(data.segments) || data.segments.length < 10) errors.push('segments must be a list of at least 10 items');
  let words = 0, pauses = 0, lines = 0, clipped = 0, prevLine = null, wordsBeforeFirstPause = null;
  let run = 0, longestRun = 0, runAt = null, learnerLines = 0;
  (data.segments || []).forEach((s, i) => {
    const at = `segment ${i + 1}`;
    if (!s || typeof s !== 'object') { errors.push(`${at}: not an object`); return; }
    if (s.type === 'pause') {
      const n = Number(s.seconds);
      if (!(n >= 4 && n <= 10)) errors.push(`${at}: pause seconds must be 4 to 10, long enough to actually think`);
      if (!prevLine || !/\?/.test(prevLine.text || '')) errors.push(`${at}: a pause must follow a question to the listener; the line before it has no question mark`);
      if (wordsBeforeFirstPause === null) wordsBeforeFirstPause = words;
      pauses++;
    } else if (s.type === 'line') {
      if (!names.includes(s.speaker)) errors.push(`${at}: speaker must be ${names.join(' or ')}`);
      if (typeof s.text !== 'string' || !s.text.trim()) errors.push(`${at}: empty text`);
      else if (s.text.length > MAX_LINE_CHARS) errors.push(`${at}: text is ${s.text.length} chars > ${MAX_LINE_CHARS}; split it into shorter spoken steps`);
      else if (/[—]/.test(s.text)) errors.push(`${at}: remove em dashes`);
      else if (/lightning round/i.test(s.text)) errors.push(`${at}: no lightning round; every concept is a lesson with a think beat`);
      else if (/brought to you by|our sponsor|sponsored by/i.test(s.text)) errors.push(`${at}: no sponsors or ads, real or made up`);
      else if (/interviews? coming up|your (next |upcoming )?(onsite|phone screen|interview)s?\b/i.test(s.text)) errors.push(`${at}: no interview framing ("interviews coming up", "your onsite"); teach the concept`);
      if (typeof s.text === 'string') {
        const hit = forbidden.find((t) => t && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s.text));
        if (hit) errors.push(`${at}: don't name companies ("${hit}"); the lesson is about the concept`);
      }
      run = prevLine && prevLine.speaker === s.speaker ? run + 1 : 1;
      if (run > longestRun) { longestRun = run; runAt = at; }
      if (s.speaker === names[1]) learnerLines++;
      const n = countWords(s.text || '');
      words += n; lines++;
      if (n < CLIPPED_WORDS) clipped++;
      prevLine = s;
    } else errors.push(`${at}: type must be line or pause`);
  });
  const { minWords, maxWords } = wordTargets(targetMinutes);
  if (words < minWords) errors.push(`only ${words} spoken words; need at least ${minWords}`);
  if (words > maxWords) errors.push(`${words} spoken words; keep it under ${maxWords}`);
  if (pauses < minPauses) errors.push(`only ${pauses} think beats (a question, then a pause); need at least ${minPauses}: one per concept plus the closing replay`);
  if (wordsBeforeFirstPause !== null && wordsBeforeFirstPause > MAX_INTRO_WORDS) errors.push(`${wordsBeforeFirstPause} words before the first question; ask it within the first ${MAX_INTRO_WORDS} words, no long intro`);
  if (longestRun > MAX_RUN) errors.push(`${runAt}: ${longestRun} lines in a row from one host; at most ${MAX_RUN}, then let ${names[1]} ask, check or voice the tempting wrong answer`);
  if (lines >= 10 && learnerLines / lines < MIN_LEARNER_SHARE) errors.push(`${names[1]} speaks ${learnerLines} of ${lines} lines; make it a conversation, at least a quarter of the lines`);
  if (lines && clipped / lines > 0.5) errors.push(`${clipped} of ${lines} lines are under ${CLIPPED_WORDS} words; that reads like clipped commentary, write full conversational sentences`);
  if (errors.length) return { ok: false, errors, words, pauses };
  return {
    ok: true, errors: [], words, pauses,
    script: {
      title: data.title.trim(), summary: data.summary.trim(),
      takeaways: Array.isArray(data.takeaways) ? data.takeaways.map(String).slice(0, 5) : [],
      segments: data.segments.map((s) => (s.type === 'pause'
        ? { type: 'pause', seconds: Number(s.seconds) }
        : { type: 'line', speaker: s.speaker, text: s.text.trim() })),
    },
  };
}

// The material is concept-only: no company names, dates or session names, so the lesson stays about the idea.
function materialText(picked) {
  const parts = [];
  if (picked.weak.length) {
    parts.push('### Mistakes he has made in practice (teach the concept behind each; never say where or when it happened)');
    for (const w of picked.weak) {
      parts.push(`- ${w.label}${w.question ? `\n  The problem: ${w.question.title}\n  What a strong answer does: ${w.question.rubric}` : ''}`);
    }
  }
  if (picked.frameworks && picked.frameworks.length) {
    parts.push('### How to talk a problem through (walk algorithm lessons through the coding loop and design lessons through the design frame, step by step, in these words)');
    for (const f of picked.frameworks) {
      parts.push(`#### ${f.title}`);
      for (const c of f.cards) parts.push(`- ${c.title}: ${c.bullets.join(' ')}`);
    }
  }
  if (picked.recall && picked.recall.length) {
    parts.push('### Rules from the last episode (open with a quick retrieval check: ask him two of these as questions, pause after each, then answer in one line)');
    for (const r of picked.recall) parts.push(`- ${r}`);
  }
  for (const t of picked.topics || []) {
    parts.push(`### Topic: ${t.title} (${t.questionCount} anticipated question${t.questionCount === 1 ? '' : 's'} across ${t.roleCount} role${t.roleCount === 1 ? '' : 's'})`);
    for (const c of t.cards || []) parts.push(`#### ${c.title} (${c.category})\n${c.bullets.map((b) => `- ${b}`).join('\n')}${c.code ? `\nCode, describe it in words:\n${c.code}` : ''}`);
    if (t.questions && t.questions.length) {
      parts.push('Anticipated questions on this topic (use at least one as the Try it; teach how to recognize it and how to set up for it):');
      for (const q of t.questions) parts.push(`- ${q.prompt}\n  Strong answer: ${q.answer}`);
    }
  }
  if (picked.cards.length) {
    parts.push('### Concepts from his study sheets');
    for (const c of picked.cards) {
      parts.push(`#### ${c.title} (${c.category})\n${c.bullets.map((b) => `- ${b}`).join('\n')}${c.code ? `\nCode, describe it in words:\n${c.code}` : ''}`);
    }
  }
  if (picked.review.length) {
    parts.push('### Due review question (must be one of the lessons)');
    for (const q of picked.review) parts.push(`Question: ${q.prompt}\nAnswer key: ${q.answer}`);
  }
  return parts.join('\n\n');
}

// The shared interview concept sheets hold the coding loop and the system design delivery frame. Only their
// process and frame cards are read; the library is never written from here.
const FRAMEWORK_SHEETS = [['coding-loop', 'The coding loop', ['process']], ['system-design-frame', 'The system design delivery frame', ['frame']]];
const NOT_FRAMEWORK = /scenario|closing questions/i;
function readFrameworks(interviewHome = process.env.INTERVIEW_HOME || path.join(require('os').homedir(), '.interview')) {
  const out = [];
  for (const [file, title, categories] of FRAMEWORK_SHEETS) {
    const sheet = readJson(path.join(interviewHome, 'cheatsheets', 'topics', `${file}.json`), null);
    const cards = ((sheet && sheet.cards) || []).filter((c) => c && categories.includes(c.category) && Array.isArray(c.bullets) && !NOT_FRAMEWORK.test(c.title || ''));
    if (cards.length) out.push({ title, cards: cards.map((c) => ({ title: String(c.title), bullets: c.bullets.map(String) })) });
  }
  return out;
}

// The step-by-step script is long; give the writer twenty minutes. A finished file counts even if the agent is cut off while summarising.
async function writeScript({ dataDir, workDir, picked, config, upcoming, timeoutMs = 1200000, runAgentFn = runAgent, frameworks = readFrameworks() }) {
  const [a, b] = config.hosts;
  const { minWords, maxWords } = wordTargets(config.targetMinutes);
  const concepts = picked.all.length;
  const minPauses = Math.max(3, concepts + 1);
  // Companies with upcoming rounds must not be spoken: the episode is about ideas, not employers. Saved roles are not
  // banned because many company names are ordinary words (Circle, Linear, Clear) that a lesson needs.
  const { activeRoles, STAGE_WEIGHT } = require('./master');
  const forbidden = [...new Set([...picked.cards.flatMap((c) => c.companies || []), ...activeRoles(dataDir).filter((r) => (STAGE_WEIGHT[r.stage] || 0) >= STAGE_WEIGHT['phone-screen']).map((r) => r.company)])].filter(Boolean);
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = path.join(workDir, OUT_FILE);
    fs.rmSync(out, { force: true });
    const prompt = renderPrompt('podcast-script-agent', {
      hostA: a.name, hostAStyle: a.style, hostB: b.name, hostBStyle: b.style,
      targetMinutes: config.targetMinutes, minWords, maxWords, minPauses, concepts,
      upcoming: upcoming.length ? upcoming.join('; ') : 'none scheduled yet',
      material: materialText({ ...picked, frameworks }),
      errors: errors.length ? `## Your previous file was rejected. Fix these problems:\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
    });
    const run = await runAgentFn({ agent: SCRIPT_AGENT, prompt, cwd: workDir, profile: 'write', timeoutMs, logFile: path.join(workDir, 'agent.log'), env: { DATA_DIR: path.resolve(dataDir) } });
    const data = readJson(out, null);
    if (!run.ok && !data) { errors = [run.timedOut ? 'the agent timed out' : `the agent exited with code ${run.code}`]; continue; }
    if (!data) { errors = [`${OUT_FILE} is missing or not valid JSON`]; continue; }
    const v = validateScript(data, { hosts: config.hosts, targetMinutes: config.targetMinutes, concepts, forbidden });
    if (v.ok) return { ok: true, script: v.script, words: v.words };
    errors = v.errors;
  }
  return { ok: false, error: `script-invalid: ${errors.slice(0, 4).join('; ')}` };
}

module.exports = { SCRIPT_AGENT, validateScript, materialText, writeScript, wordTargets, readFrameworks };
