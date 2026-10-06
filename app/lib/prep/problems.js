// app/lib/prep/problems.js
// Add drills to Code Lab (problems/problems.json). Each drill arrives with a reference solution
// that must pass every one of its tests in Code Lab's own runner; the solution is not stored.
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const MAX_PROBLEMS = 20;

class ProblemError extends Error {
  constructor(message) { super(message); this.code = 'INPUT'; }
}

function slugTitle(id) {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function validateProblem(p, i, existingIds) {
  const where = `problems[${i}]`;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ProblemError(`${where} must be an object`);
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) throw new ProblemError(`${where}.id must be a lowercase slug`);
  if (existingIds.has(p.id)) throw new ProblemError(`${where}.id "${p.id}" already exists in Code Lab; pick a new id`);
  for (const k of ['title', 'description', 'starterCode', 'functionName', 'referenceSolution']) {
    if (typeof p[k] !== 'string' || !p[k].trim()) throw new ProblemError(`${where}.${k} must be non-empty text`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.functionName)) throw new ProblemError(`${where}.functionName must be a Python identifier`);
  if (typeof p.category !== 'string' || !ID_RE.test(p.category)) throw new ProblemError(`${where}.category must be a slug`);
  if (!DIFFICULTIES.includes(p.difficulty)) throw new ProblemError(`${where}.difficulty must be easy, medium, or hard`);
  if (!Array.isArray(p.testCases) || p.testCases.length < 2) throw new ProblemError(`${where}.testCases needs at least 2 tests`);
  p.testCases.forEach((t, j) => {
    if (!t || typeof t !== 'object' || !t.input || typeof t.input !== 'object' || Array.isArray(t.input) || !('expected' in t)) {
      throw new ProblemError(`${where}.testCases[${j}] needs an input object and an expected value`);
    }
  });
  for (const k of ['examples', 'constraints', 'hints', 'tags']) {
    if (p[k] != null && !Array.isArray(p[k])) throw new ProblemError(`${where}.${k} must be an array`);
  }
}

function addProblems(dataDir, body, { runTests }) {
  const list = body && body.problems;
  if (!Array.isArray(list) || !list.length) throw new ProblemError('problems must be a non-empty array');
  if (list.length > MAX_PROBLEMS) throw new ProblemError(`add at most ${MAX_PROBLEMS} problems at a time`);
  const file = path.join(dataDir, 'problems', 'problems.json');
  let data = { categories: [], problems: [] };
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`could not read problems.json: ${err.message}`);
  }
  data.categories = Array.isArray(data.categories) ? data.categories : [];
  data.problems = Array.isArray(data.problems) ? data.problems : [];
  const ids = new Set(data.problems.map((p) => p.id));
  list.forEach((p, i) => {
    validateProblem(p, i, ids);
    ids.add(p.id);
  });
  // Verify every drill before writing any of them.
  list.forEach((p, i) => {
    const r = runTests(p.referenceSolution, p.functionName, p.testCases);
    if (r.error) throw new ProblemError(`problems[${i}] (${p.id}): reference solution failed to run: ${r.error}${r.errorDetails ? ` (${r.errorDetails})` : ''}`);
    const failed = (r.results || []).filter((x) => !x.passed);
    if (failed.length || (r.results || []).length !== p.testCases.length) {
      const f = failed[0] || {};
      throw new ProblemError(`problems[${i}] (${p.id}): reference solution fails test ${f.index}: ${f.error || `expected ${f.expected}, got ${f.actual}`}`);
    }
  });
  const nextOrder = data.problems.reduce((n, p) => Math.max(n, Number(p.order) || 0), 0) + 1;
  const added = list.map((p, i) => ({
    id: p.id, title: p.title.trim(), category: p.category, difficulty: p.difficulty, order: nextOrder + i,
    description: p.description, examples: p.examples || [], constraints: p.constraints || [],
    starterCode: p.starterCode, functionName: p.functionName, testCases: p.testCases,
    hints: p.hints || [], tags: p.tags || [],
  }));
  const cats = new Set(data.categories.map((c) => c.id));
  for (const p of added) {
    if (!cats.has(p.category)) {
      data.categories.push({ id: p.category, name: slugTitle(p.category), order: data.categories.reduce((n, c) => Math.max(n, Number(c.order) || 0), 0) + 1 });
      cats.add(p.category);
    }
  }
  data.problems.push(...added);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return { added: added.map((p) => p.id), tests: added.reduce((n, p) => n + p.testCases.length, 0) };
}

module.exports = { addProblems, ProblemError };
