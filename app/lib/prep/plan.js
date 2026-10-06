// app/lib/prep/plan.js
// A prep plan is a set of dated Daily Tasks (tasks/<date>.json) tagged with a planId.
// Re-applying a plan replaces its unfinished tasks from today on, keeps finished ones,
// and never touches tasks from other sources (daily intel, interview follow-ups).
const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CATEGORIES = ['coding', 'system-design', 'behavioral', 'research', 'networking', 'application'];
const LINK_KINDS = ['workbook', 'codelab', 'sysdesign'];
const MAX_TASKS = 200;

class PlanError extends Error {
  constructor(message) { super(message); this.code = 'INPUT'; }
}

function validateLink(link, where, ctx) {
  if (link == null) return null;
  if (typeof link !== 'object' || Array.isArray(link)) throw new PlanError(`${where}.link must be an object`);
  if (!LINK_KINDS.includes(link.kind)) throw new PlanError(`${where}.link.kind must be one of ${LINK_KINDS.join(', ')}`);
  if (link.kind === 'workbook') {
    if (typeof link.workbookId !== 'string' || !ctx.workbookExists(link.workbookId)) throw new PlanError(`${where}.link.workbookId "${link.workbookId}" is not a workbook`);
    if (link.chapter != null && (typeof link.chapter !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(link.chapter))) throw new PlanError(`${where}.link.chapter must be a chapter id`);
    return { kind: 'workbook', workbookId: link.workbookId, ...(link.chapter ? { chapter: link.chapter } : {}) };
  }
  if (link.kind === 'codelab') {
    if (typeof link.problemId !== 'string' || !ctx.problemExists(link.problemId)) throw new PlanError(`${where}.link.problemId "${link.problemId}" is not a Code Lab problem`);
    return { kind: 'codelab', problemId: link.problemId };
  }
  if (typeof link.topicId !== 'string' || !ctx.sdTopicExists(link.topicId)) throw new PlanError(`${where}.link.topicId "${link.topicId}" is not a System Design topic`);
  return { kind: 'sysdesign', topicId: link.topicId };
}

function validatePlan(body, ctx) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PlanError('plan body must be an object');
  const { planId, tasks } = body;
  if (typeof planId !== 'string' || !PLAN_ID_RE.test(planId)) throw new PlanError('planId must be a lowercase slug (letters, digits, dashes)');
  if (!Array.isArray(tasks)) throw new PlanError('tasks must be an array');
  if (tasks.length > MAX_TASKS) throw new PlanError(`a plan holds at most ${MAX_TASKS} tasks`);
  return tasks.map((t, i) => {
    const where = `tasks[${i}]`;
    if (!t || typeof t !== 'object') throw new PlanError(`${where} must be an object`);
    if (typeof t.date !== 'string' || !DATE_RE.test(t.date)) throw new PlanError(`${where}.date must be YYYY-MM-DD`);
    if (t.date < ctx.today) throw new PlanError(`${where}.date ${t.date} is in the past`);
    if (typeof t.text !== 'string' || !t.text.trim()) throw new PlanError(`${where}.text must be non-empty`);
    if (!CATEGORIES.includes(t.category)) throw new PlanError(`${where}.category must be one of ${CATEGORIES.join(', ')}`);
    if (t.content != null && typeof t.content !== 'string') throw new PlanError(`${where}.content must be a string`);
    if (t.minutes != null && !(Number.isInteger(t.minutes) && t.minutes > 0 && t.minutes <= 600)) throw new PlanError(`${where}.minutes must be 1–600`);
    if (t.roleKey != null && (typeof t.roleKey !== 'string' || !t.roleKey.includes('|'))) throw new PlanError(`${where}.roleKey must look like "Company|Role"`);
    const link = validateLink(t.link, where, ctx);
    const task = {
      text: t.text.trim(), category: t.category, completed: false, content: t.content || '',
      source: 'prep-plan', planId,
    };
    if (t.minutes) task.minutes = t.minutes;
    if (t.roleKey) task.roleKey = t.roleKey;
    if (link) task.link = link;
    // Code Lab and the auto-complete-on-solve hook key off problemId.
    if (link && link.kind === 'codelab') task.problemId = link.problemId;
    return { date: t.date, task };
  });
}

function readDay(file, date) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { ...data, date: data.date || date, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { date, tasks: [] };
    throw new Error(`could not read ${path.basename(file)}: ${err.message}`);
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function applyPlan(dataDir, body, ctx) {
  const items = validatePlan(body, ctx);
  const { planId } = body;
  const dir = path.join(dataDir, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const byDate = new Map();
  for (const { date, task } of items) {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(task);
  }
  // Every file from today on that holds this plan's unfinished tasks, plus every date the new plan uses.
  const dates = new Set(byDate.keys());
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (m && m[1] >= ctx.today) dates.add(m[1]);
  }
  let added = 0; let removed = 0; let kept = 0;
  for (const date of [...dates].sort()) {
    const file = path.join(dir, `${date}.json`);
    const day = readDay(file, date);
    const ours = (t) => t && t.source === 'prep-plan' && t.planId === planId;
    const before = day.tasks.length;
    const finished = day.tasks.filter((t) => ours(t) && t.completed);
    const others = day.tasks.filter((t) => !ours(t));
    const finishedTexts = new Set(finished.map((t) => t.text));
    const fresh = (byDate.get(date) || []).filter((t) => !finishedTexts.has(t.text));
    const next = [...others, ...finished, ...fresh];
    removed += before - others.length - finished.length;
    kept += finished.length;
    added += fresh.length;
    if (before === 0 && next.length === 0) continue;
    if (JSON.stringify(next) === JSON.stringify(day.tasks)) continue;
    writeAtomic(file, { ...day, tasks: next });
  }
  return { planId, added, removed, kept, days: byDate.size };
}

module.exports = { applyPlan, validatePlan, PlanError, CATEGORIES, LINK_KINDS };
