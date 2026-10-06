// app/lib/codelab/store.js
// Reads Code Lab problems for the dashboard. Whenever problems.json changes on disk (the daily intel agent
// or an older install may write it directly), it migrates converter-wrapping starters to adapters and lints
// every problem, so a mismatched problem shows a warning in Code Lab instead of failing silently.
const fs = require('fs');
const path = require('path');
const { migrateProblemsFile } = require('./migrate');
const { lintProblems } = require('./runner');
const { getWorkbookCodeProblems } = require('../workbook/codelab');

const WORKBOOK_CATEGORY = { id: 'workbook', name: 'From your workbooks', order: 999 };

function createProblemStore(dataDir, { log = (m) => console.log(m) } = {}) {
  const file = path.join(dataDir, 'problems', 'problems.json');
  let cache = null;

  // problems.json plus the verified code questions from workbooks (their own cache, keyed on verify.json).
  function read() {
    const base = readFile();
    let fromWorkbooks = [];
    try { fromWorkbooks = getWorkbookCodeProblems(dataDir); } catch (err) { log(`[codelab] workbook problems skipped: ${err.message}`); }
    if (!fromWorkbooks.length) return base;
    const ids = new Set(base.problems.map((p) => p.id));
    return {
      ...base,
      categories: [...(base.categories || []).filter((c) => c.id !== WORKBOOK_CATEGORY.id), WORKBOOK_CATEGORY],
      problems: [...base.problems, ...fromWorkbooks.filter((p) => !ids.has(p.id))],
    };
  }

  function readFile() {
    let stat;
    try { stat = fs.statSync(file); } catch { return { categories: [], problems: [] }; }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.data;
    const m = migrateProblemsFile(dataDir);
    if (m.migrated.length) log(`[codelab] moved ${m.migrated.length} problem(s) to boundary adapters: ${m.migrated.join(', ')} (backup: ${path.basename(m.backup)})`);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    let issues = {};
    try { issues = lintProblems(data.problems || []); } catch (err) { log(`[codelab] lint skipped: ${err.message}`); }
    const flagged = Object.entries(issues).filter(([, v]) => v.length);
    if (flagged.length) log(`[codelab] ${flagged.length} problem(s) do not match their tests: ${flagged.map(([k]) => k).join(', ')}`);
    const out = { ...data, problems: (data.problems || []).map((p) => (issues[p.id] && issues[p.id].length ? { ...p, issues: issues[p.id] } : p)) };
    const after = fs.statSync(file);
    cache = { mtimeMs: after.mtimeMs, size: after.size, data: out };
    return out;
  }

  return { read, invalidate: () => { cache = null; } };
}

module.exports = { createProblemStore };
