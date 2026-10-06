// app/lib/workbook/import.js
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { parseContentDir } = require('./parse');
const { lintWorkbook } = require('./lint');
const { verifyQuestion } = require('./verify');
const { mergeGlossaries } = require('./glossary');
const { splitRoleKey } = require('../jobs/roles');

async function importKit({ dataDir, srcDir, roleKeys, title, tier = 'onsite', now = () => new Date(), python }) {
  const src = path.join(srcDir, 'content');
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`${srcDir} has no content/ directory`);
  if (!Array.isArray(roleKeys) || !roleKeys.length) throw new Error('at least one --roles "Company|Role" is required');
  for (const k of roleKeys) {
    if (typeof k !== 'string' || !k.includes('|')) throw new Error(`role keys must look like "Company|Role": ${k}`);
    const { company, role } = splitRoleKey(k);
    if (!company.trim() || !role.trim()) throw new Error(`role keys must look like "Company|Role": ${k}`);
  }
  if (!['screen', 'onsite'].includes(tier)) throw new Error('--tier must be screen or onsite');
  let existing = null;
  for (const k of roleKeys) {
    const hit = store.findByRoleKey(dataDir, k);
    if (hit && hit.source !== 'interview') throw new Error(`a workbook already covers ${k}: ${hit.id}`);
    if (hit && existing && hit.id !== existing.id) throw new Error('role keys cover multiple interview workbooks');
    if (hit) existing = hit;
  }
  const names = fs.readdirSync(src).filter((n) => !n.startsWith('.') && (n.endsWith('.md') || /^glossary-.*\.txt$/.test(n))).sort();
  if (!names.some((n) => n.endsWith('.md'))) throw new Error(`${src} has no .md chapter files`);
  const companies = [...new Set(roleKeys.map((k) => splitRoleKey(k).company))];
  const options = {
    roleKeys, title: title || `${companies.join(' + ')} prep kit`, tier, source: 'imported', trigger: 'import', status: 'generating', researched: null,
  };
  const created = existing ? { ...existing, ...options,
    roleKeys: [...new Set([...existing.roleKeys, ...roleKeys])],
    companyNames: { ...existing.companyNames, ...store.companyNamesFor(roleKeys) },
  } : store.createWorkbook(dataDir, options, now);
  const dir = store.wbDir(dataDir, created.id);
  const backups = new Map();
  const remember = (file) => backups.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
  if (existing) {
    for (const n of names) remember(path.join(dir, 'content', n));
    for (const n of ['meta.json', 'lint.json', 'verify.json', 'glossary.json']) remember(path.join(dir, n));
  }
  try {
    for (const n of names) {
      if (existing && n === store.ASKED.file && fs.existsSync(path.join(dir, 'content', n))) continue;
      fs.copyFileSync(path.join(src, n), path.join(dir, 'content', n));
    }

    const parsed = parseContentDir(path.join(dir, 'content'));
    const findings = lintWorkbook({ files: parsed.files, glossaryFiles: parsed.glossaryFiles }, { allowMissingTests: true });
    const byChapter = Object.create(null);
    const results = [];
    for (const q of parsed.questions.filter((x) => x.type === 'code')) {
      const r = await verifyQuestion(q, python ? { python } : {});
      results.push(r);
      (byChapter[q.chapter || 'unknown'] = byChapter[q.chapter || 'unknown'] || []).push(r);
    }
    const glossary = mergeGlossaries(parsed.glossaryFiles, store.nolinkFor(created));
    store.writeJsonAtomic(path.join(dir, 'lint.json'), findings);
    store.writeJsonAtomic(path.join(dir, 'verify.json'), { checkedAt: now().toISOString(), chapters: byChapter });
    store.writeJsonAtomic(path.join(dir, 'glossary.json'), glossary);
    const meta = store.writeMeta(dataDir, { ...created, status: 'ready' }, now);

    const count = (type) => parsed.questions.filter((q) => q.type === type).length;
    return {
      id: meta.id,
      title: meta.title,
      dir,
      chapters: parsed.chapters.length,
      questions: parsed.questions.length,
      glossary: glossary.length,
      types: { mcq: count('mcq'), open: count('open'), code: count('code') },
      lint: {
        errors: findings.filter((f) => f.severity === 'error').length,
        warnings: findings.filter((f) => f.severity === 'warning').length,
        findings: findings.slice(0, 50),
      },
      verify: {
        passed: results.filter((r) => r.pass).length,
        failed: results.filter((r) => !r.pass && !r.unverified).length,
        unverified: results.filter((r) => r.unverified).length,
      },
    };
  } catch (err) {
    if (!existing) store.deleteWorkbook(dataDir, created.id);
    else for (const [file, bytes] of backups) {
      if (bytes === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, bytes);
    }
    throw err;
  }
}

module.exports = { importKit };
