// app/lib/workbook/codelab.js
// Workbook code questions whose @@tests passed verification become Code Lab problems, the same way
// system design questions become System Design topics. Ids are stable per (workbook, question), so
// Code Lab progress and saved code survive rebuilds of the list.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('./store');
const { parseTests, referenceSolution } = require('./parse');

const { codeProblemId, passingQids } = store;

const SKELETON = path.join(__dirname, '..', 'codelab', 'skeleton.py');
const DIFFICULTY = { 1: 'easy', 2: 'medium', 3: 'hard' };

function title(body, fallback) {
  const line = String(body || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || fallback;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function testCases(spec) {
  if (Array.isArray(spec.cases)) return spec.cases.map((c) => ({ args: c.args, expected: c.expect }));
  const calls = [...spec.calls];
  const init = calls.length && calls[0][0] === '__init__' ? calls.shift()[1] : [];
  return [{ input: { init, operations: calls.map(([m, args]) => [m, ...args]) }, expected: calls.map((c) => c[2]) }];
}

// Verified code questions for one workbook, without starter code (see withStarters).
function candidates(dataDir, meta) {
  const passing = passingQids(dataDir, meta.id);
  if (!passing.size) return [];
  const company = Object.keys(meta.companyNames || {})[0] || '';
  const out = [];
  for (const q of store.loadParsed(dataDir, meta.id).questions) {
    if (q.type !== 'code' || !passing.has(q.id)) continue;
    const t = parseTests(q.tests);
    if (!t.ok) continue;
    const code = referenceSolution(q.answer, t.value.entry);
    if (!code) continue;
    out.push({
      problem: {
        id: codeProblemId(meta.id, q.id), title: title(q.body, q.id), category: 'workbook', difficulty: DIFFICULTY[q.diff] || 'medium',
        order: 0, description: String(q.body || '').trim(), examples: [], constraints: [], functionName: t.value.entry,
        testCases: testCases(t.value), hints: q.hint ? [String(q.hint).trim()] : [],
        tags: ['workbook', ...(company ? [company] : [])], workbookId: meta.id, qid: q.id,
        source: { workbookId: meta.id, qid: q.id, title: meta.title || meta.id },
      },
      code,
    });
  }
  return out;
}

function withStarters(items) {
  if (!items.length) return [];
  let starters = {};
  try {
    const outText = execFileSync('python3', [SKELETON], {
      input: JSON.stringify(items.map((x) => ({ id: x.problem.id, code: x.code, entry: x.problem.functionName }))),
      encoding: 'utf-8', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    });
    starters = JSON.parse(outText);
  } catch { /* fall back to a bare signature below */ }
  return items.map(({ problem, code }) => {
    const sig = new RegExp(`^(?:def|class) ${problem.functionName}\\b[^\\n]*`, 'm').exec(code);
    return { ...problem, starterCode: starters[problem.id] || `${sig ? sig[0] : `def ${problem.functionName}():`}\n    pass\n` };
  });
}

// Cached on the verify.json and content timestamps of every workbook.
let cache = { key: null, value: [] };
function getWorkbookCodeProblems(dataDir) {
  const metas = store.listWorkbooks(dataDir);
  const stamp = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const key = JSON.stringify(metas.map((m) => {
    const dir = store.wbDir(dataDir, m.id);
    return [m.id, stamp(path.join(dir, 'verify.json')), stamp(path.join(dir, 'content'))];
  }));
  if (cache.key === key && cache.dataDir === dataDir) return cache.value;
  const value = withStarters(metas.flatMap((m) => candidates(dataDir, m)));
  cache = { key, dataDir, value };
  return value;
}

module.exports = { getWorkbookCodeProblems, codeProblemId, passingQids };
