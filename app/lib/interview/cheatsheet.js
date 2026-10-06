// app/lib/interview/cheatsheet.js
// Agent condenses the workbook into cards; code validates the schema and caches by content hash.
const fs = require('fs');
const path = require('path');
const { runAgent } = require('../jobs/runner');
const { renderPrompt } = require('./prompts');
const bridge = require('./workbook-bridge');

const CATEGORIES = ['warmup', 'intro', 'algorithms', 'probability', 'fundamentals', 'infra', 'design', 'critique'];
const CHEATSHEET_AGENT = 'interview-cheatsheet';
const OUT_FILE = 'cheatsheet.out.json';
const FIELDS = ['title', 'category', 'bullets', 'code'];
const MAX_CARDS = 40;
const MAX_BULLET = 240;
const diagnosticValue = (v) => JSON.stringify(typeof v === 'string' ? v.slice(0, 120) : v)?.slice(0, 160);

function cheatsheetWorkDir(dataDir, roleId) {
  if (typeof roleId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(roleId)) throw new Error(`invalid roleId: ${roleId}`);
  return path.join(dataDir, 'interview-work', 'cheatsheets', roleId);
}

function validateCheatsheet(data) {
  const cards = Array.isArray(data) ? data : (data && Array.isArray(data.cards) ? data.cards : null);
  if (!cards) return { ok: false, errors: ['expected a JSON list of cards or {"cards": [...]}'], cards: [] };
  const errors = [];
  if (cards.length === 0) errors.push('no cards');
  if (cards.length > MAX_CARDS) errors.push(`too many cards: ${cards.length} > ${MAX_CARDS}`);
  cards.forEach((c, i) => {
    const at = `card ${i + 1}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${at}: not an object`); return; }
    if (typeof c.title !== 'string' || !c.title.trim()) errors.push(`${at}: missing title`);
    if (!CATEGORIES.includes(c.category)) errors.push(`${at}: category ${diagnosticValue(c.category)} is not one of ${CATEGORIES.join(', ')}`);
    if (!Array.isArray(c.bullets) || c.bullets.length < 4 || c.bullets.length > 6) {
      errors.push(`${at}: needs 4 to 6 bullets, has ${Array.isArray(c.bullets) ? c.bullets.length : 0}`);
    } else {
      c.bullets.forEach((b, j) => {
        if (typeof b !== 'string' || !b.trim()) errors.push(`${at} bullet ${j + 1}: empty`);
        else if (b.length > MAX_BULLET) errors.push(`${at} bullet ${j + 1}: ${b.length} chars > ${MAX_BULLET}`);
      });
    }
    if (c.code !== undefined && c.code !== null && typeof c.code !== 'string') errors.push(`${at}: code must be a string`);
    if (typeof c.code === 'string' && c.code.split('\n').length > 15) errors.push(`${at}: code has ${c.code.split('\n').length} lines > 15`);
    for (const k of Object.keys(c)) if (!FIELDS.includes(k)) errors.push(`${at}: unknown field ${diagnosticValue(k)}`);
  });
  if (errors.length) return { ok: false, errors, cards: [] };
  return {
    ok: true, errors: [],
    cards: cards.map((c) => ({ title: c.title.trim(), category: c.category, bullets: c.bullets.map((b) => b.trim()), ...(c.code ? { code: c.code } : {}) })),
  };
}

function chaptersText(content) {
  return content.chapters
    .filter((c) => c.id !== bridge.INTERVIEW_CHAPTER_ID)
    .map((c) => `## ${c.title} (topic: ${c.topic})\n\n${c.body}`)
    .join('\n\n')
    .slice(0, 60000);
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

async function buildCheatsheet({ dataDir, roleId, company, role, workbookId, noAgent = false, timeoutMs = 240000, runAgentFn = runAgent, now = () => new Date() }) {
  let dir;
  try { dir = cheatsheetWorkDir(dataDir, roleId); }
  catch (error) { return { ok: false, error: error.message }; }
  fs.mkdirSync(dir, { recursive: true });
  const cacheFile = path.join(dir, 'cheatsheet.json');
  const sourceHash = bridge.contentHash(dataDir, workbookId);
  const cached = readJsonSafe(cacheFile);
  const validated = cached && validateCheatsheet(cached.cards);
  const cache = validated && validated.ok ? { sourceHash: cached.sourceHash, cards: validated.cards } : null;
  if (cache && cache.sourceHash === sourceHash) return { ok: true, cards: cache.cards, cached: true, stale: false };
  const fallback = (error) => (cache ? { ok: true, cards: cache.cards, cached: true, stale: true, error } : { ok: false, error });
  if (noAgent) return fallback('cheatsheet-not-built');

  const chapters = chaptersText(bridge.readWorkbook(dataDir, workbookId));
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = path.join(dir, OUT_FILE);
    fs.rmSync(out, { force: true });
    const prompt = renderPrompt('cheatsheet-agent', {
      company, role, categories: CATEGORIES.join(', '), chapters,
      errors: errors.length ? `Your previous file was rejected. Fix these problems:\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
    });
    const run = await runAgentFn({ agent: CHEATSHEET_AGENT, prompt, cwd: dir, profile: 'write', timeoutMs, logFile: path.join(dir, 'agent.log'), env: { DATA_DIR: path.resolve(dataDir) } });
    if (!run.ok) {
      errors = [run.timedOut ? 'the agent timed out' : (run.signal ? `the agent terminated by ${run.signal}` : `the agent exited with code ${run.code}`)];
      continue;
    }
    const data = readJsonSafe(out);
    if (data === null) { errors = [`${OUT_FILE} is missing or not valid JSON`]; continue; }
    const v = validateCheatsheet(data);
    if (v.ok) {
      fs.writeFileSync(cacheFile, JSON.stringify({ sourceHash, builtAt: now().toISOString(), cards: v.cards }, null, 2));
      return { ok: true, cards: v.cards, cached: false, stale: false };
    }
    errors = v.errors;
  }
  return fallback(`cheatsheet-invalid: ${errors.slice(0, 3).join('; ')}`);
}

module.exports = { CATEGORIES, CHEATSHEET_AGENT, cheatsheetWorkDir, validateCheatsheet, buildCheatsheet };
