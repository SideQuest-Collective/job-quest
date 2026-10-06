// app/lib/codelab/migrate.js
// Older Code Lab problems converted test arrays into TreeNode/ListNode/Node objects inside the user's
// own function (tree = _build_tree(root) ... return _serialize_tree(tree)). Any recursive solution then
// called itself with a node instead of an array and broke. This rewrites such problems to declare
// `adapters` so the runner converts at the boundary, with a clean starter. Problems with adapters are skipped.
const fs = require('fs');
const path = require('path');

const BUILDERS = { _build_tree: 'tree', _build_list: 'list', _build_graph: 'graph' };
const SERIALIZERS = { _serialize_tree: 'tree', _list_to_array: 'list', _graph_to_adj_list: 'graph' };
const NODE_CLASS = { tree: 'TreeNode', list: 'ListNode', graph: 'Node' };
const ARG_NOTE = {
  tree: 'a TreeNode or None (Code Lab builds it from the test\'s level-order array)',
  list: 'a ListNode or None (Code Lab builds it from the test\'s array)',
  graph: 'a Node or None (Code Lab builds it from the test\'s 1-indexed adjacency list)',
};
const RETURN_NOTE = {
  tree: 'a TreeNode or None; Code Lab turns it back into a level-order array',
  list: 'a ListNode or None; Code Lab turns it back into an array',
  graph: 'a Node or None; Code Lab turns it back into an adjacency list',
};
const DESCRIPTION_NOTE = '**How Code Lab calls this:** your function receives real node objects and returns them; Code Lab converts the test arrays at the boundary, so recursion on nodes just works.';

// The source of `def name(...)` up to the next top-level statement.
function functionSource(code, name) {
  const m = new RegExp(`^def ${name}\\s*\\(([^)]*)\\)\\s*(->[^:]*)?:[^\\n]*\\n`, 'm').exec(code);
  if (!m) return null;
  const rest = code.slice(m.index + m[0].length);
  const end = rest.search(/^\S/m);
  return { params: m[1], header: m[0], body: end >= 0 ? rest.slice(0, end) : rest };
}

function classSource(code, name) {
  const m = new RegExp(`^class ${name}\\b[^\\n]*\\n`, 'm').exec(code);
  if (!m) return null;
  const rest = code.slice(m.index + m[0].length);
  const end = rest.search(/^\S/m);
  return (m[0] + (end >= 0 ? rest.slice(0, end) : rest)).replace(/\s+$/, '');
}

function paramNames(params) {
  return params.split(',').map((p) => p.trim().split(/[=:]/)[0].trim()).filter((p) => p && p !== 'self' && !p.startsWith('*'));
}

function firstDocLine(body) {
  const m = /^\s*(?:"""|''')\s*([^\n]*?)\s*(?:"""|''')?\s*$/m.exec(body.split('\n').find((l) => l.trim()) || '');
  return m && m[1] && !/^(your code|return|from here)/i.test(m[1]) ? m[1].replace(/["']{3}$/, '') : null;
}

function migrateProblem(p) {
  if (!p || p.adapters || typeof p.starterCode !== 'string' || typeof p.functionName !== 'string') return null;
  const code = p.starterCode;
  if (!Object.keys(BUILDERS).some((b) => new RegExp(`^def ${b}\\(`, 'm').test(code))) return null;
  const fn = functionSource(code, p.functionName);
  if (!fn) return null;
  const params = paramNames(fn.params);
  const args = {};
  for (const [builder, kind] of Object.entries(BUILDERS)) {
    for (const m of fn.body.matchAll(new RegExp(`${builder}\\(\\s*([A-Za-z_]\\w*)\\s*\\)`, 'g'))) {
      if (params.includes(m[1])) args[m[1]] = kind;
    }
  }
  if (!Object.keys(args).length) return null;
  let returns = null;
  for (const [ser, kind] of Object.entries(SERIALIZERS)) {
    // A call, or a comment telling the user to serialize on the way out with a helper the starter defines.
    if (fn.body.includes(`${ser}(`) || (/serializ/i.test(fn.body) && new RegExp(`^def ${ser}\\(`, 'm').test(code))) returns = kind;
  }
  const kinds = new Set([...Object.values(args), ...(returns ? [returns] : [])]);
  const classes = [...kinds].map((k) => classSource(code, NODE_CLASS[k])).filter(Boolean);
  const doc = firstDocLine(fn.body);
  const lines = [];
  if (doc) lines.push(doc, '');
  for (const name of params) if (args[name]) lines.push(`${name}: ${ARG_NOTE[args[name]]}.`);
  if (returns) lines.push(`Return ${RETURN_NOTE[returns]}.`);
  const starter = [
    ...classes, '', '',
    `def ${p.functionName}(${params.join(', ')}):`,
    `    """${lines.map((l) => l).join('\n    ').replace(/[ \t]+$/gm, '')}\n    """`,
    '    pass', '',
  ].join('\n').replace(/^\n+/, '');
  const description = String(p.description || '')
    .split(/\n{2,}/).filter((para) => !/^\*\*Starter note:?\*\*/i.test(para.trim()) && !/_build_|_serialize|the runner will/i.test(para))
    .concat(DESCRIPTION_NOTE).join('\n\n');
  return { ...p, starterCode: starter, description, adapters: { args, ...(returns ? { returns } : {}) } };
}

function migrateProblems(data) {
  if (!data || !Array.isArray(data.problems)) return { data, migrated: [] };
  const migrated = [];
  const problems = data.problems.map((p) => {
    const next = migrateProblem(p);
    if (!next) return p;
    migrated.push(p.id);
    return next;
  });
  return { data: migrated.length ? { ...data, problems } : data, migrated };
}

// Migrates <dataDir>/problems/problems.json in place, keeping one backup of the original.
function migrateProblemsFile(dataDir, { stamp = new Date().toISOString().slice(0, 10) } = {}) {
  const file = path.join(dataDir, 'problems', 'problems.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return { migrated: [] }; }
  const { data: next, migrated } = migrateProblems(data);
  if (!migrated.length) return { migrated };
  const backup = `${file}.before-adapters-${stamp}`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return { migrated, backup };
}

module.exports = { migrateProblem, migrateProblems, migrateProblemsFile };
