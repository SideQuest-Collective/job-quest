// Follow-ups become daily tasks, deduped by key across all JSON task files.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');
const { getLocalDateStamp } = require('../local-date');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [year, month, day] = s.split('-').map(Number);
  // UTC avoids DST normalization; setUTCFullYear also handles years below 100.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function tasksDir(dataDir) { return path.join(dataDir, 'tasks'); }

function existingKeys(dataDir) {
  const keys = new Set();
  const dir = tasksDir(dataDir);
  if (!fs.existsSync(dir)) return keys;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch { continue; }
    if (!data || !Array.isArray(data.tasks)) continue;
    for (const task of data.tasks) if (task && task.dedupeKey) keys.add(task.dedupeKey);
  }
  return keys;
}

function upsertTasks(dataDir, items, { now = () => new Date() } = {}) {
  const have = existingKeys(dataDir);
  const today = getLocalDateStamp(now());
  const added = [];
  const existing = [];
  const rejected = [];
  const byDate = new Map();
  for (const item of items) {
    if (!item?.dedupeKey) { rejected.push({ item, reason: 'missing dedupeKey' }); continue; }
    if (have.has(item.dedupeKey)) { existing.push(item.dedupeKey); continue; }
    const date = isValidDate(item.due) && item.due > today ? item.due : today;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({
      text: item.text, category: 'application', completed: false, content: item.content || '',
      dedupeKey: item.dedupeKey, source: 'interview',
    });
    added.push(item.dedupeKey);
    have.add(item.dedupeKey);
  }
  for (const [date, tasks] of byDate) {
    const file = path.join(tasksDir(dataDir), `${date}.json`);
    let data = { date, tasks: [] };
    if (fs.existsSync(file)) {
      const contents = fs.readFileSync(file, 'utf-8');
      try { data = JSON.parse(contents); } catch {
        throw new Error(`tasks file ${file} is not valid JSON; not modified`);
      }
    }
    // Fail closed instead of discarding a field written by another producer.
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (data.tasks !== undefined && !Array.isArray(data.tasks))) {
      throw new Error(`tasks file ${file} has invalid task schema; not modified`);
    }
    if (data.date === undefined) data.date = date;
    if (data.tasks === undefined) data.tasks = [];
    data.tasks.push(...tasks);
    writeFileAtomic(file, JSON.stringify(data, null, 2));
  }
  return { added, existing, rejected };
}

function missingTaskKeys(dataDir, keys) {
  const have = existingKeys(dataDir);
  return (keys || []).filter((key) => !have.has(key));
}

module.exports = { isValidDate, upsertTasks, missingTaskKeys };
