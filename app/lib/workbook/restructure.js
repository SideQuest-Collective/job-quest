// app/lib/workbook/restructure.js
// Rewrites existing system design chapters into the delivery framework (the sections in lint's
// SD_HEADINGS), one chapter at a time. Only the chapter body changes: its @@chapter line and its
// questions stay byte for byte. A rewrite is checked before it replaces anything, and the original
// file is backed up first.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { REF_DIR, renderTemplate, renderStyleGuide, formatSpec } = require('./prompts');
const { lintWorkbook } = require('./lint');
const { parseContentDir } = require('./parse');
const { mergeGlossaries } = require('./glossary');
const guide = require('./guide');
const { splitRoleKey } = require('../jobs/roles');

const TIMEOUT_MS = 15 * 60000;
const STATE = 'restructure.json';
const read = (f) => { try { return fs.readFileSync(f, 'utf-8'); } catch { return null; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return d; } };

function jobKey(id) { return `workbook-restructure:${id}`; }
function readState(dataDir, id) { return readJson(path.join(store.wbDir(dataDir, id), STATE), null); }
function writeState(dataDir, id, s) { store.writeJsonAtomic(path.join(store.wbDir(dataDir, id), STATE), s); }

// Where a chapter's body sits in its file: the lines after its @@chapter line, up to the next @@ line.
function locate(text, chapterId) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^@@chapter\s/.test(l) && new RegExp(`\\sid=${chapterId}(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^@@(chapter|q)\s/.test(lines[end])) end++;
  return { lines, start, end, header: lines[start], body: lines.slice(start + 1, end).join('\n') };
}

function splice(text, chapterId, newBody) {
  const loc = locate(text, chapterId);
  if (!loc) throw new Error(`chapter ${chapterId} not found`);
  const body = newBody.replace(/\r/g, '').replace(/\s+$/, '');
  return [...loc.lines.slice(0, loc.start + 1), body, '', ...loc.lines.slice(loc.end)].join('\n');
}

function structureProblems(header, body) {
  return lintWorkbook({ files: [{ name: 'draft.md', text: `${header}\n${body}\n` }] }, { standard: true })
    .filter((f) => f.severity === 'error')
    .map((f) => f.message);
}

// System design chapters that do not yet follow the delivery framework.
function candidates(dataDir, id) {
  const dir = path.join(store.wbDir(dataDir, id), 'content');
  return parseContentDir(dir).chapters
    .filter((c) => /^system design$/i.test(String(c.topic || '').trim()))
    .filter((c) => {
      const loc = locate(read(path.join(dir, c.file)) || '', c.id);
      return loc && structureProblems(loc.header, loc.body).length > 0;
    })
    .map((c) => ({ id: c.id, title: c.title, file: c.file }));
}

function questionsText(parsed, chapterId) {
  const qs = parsed.questions.filter((q) => q.chapter === chapterId);
  if (!qs.length) return '- (none)';
  return qs.map((q, i) => `${i + 1}. (${q.type}) ${q.body.trim().replace(/\n+/g, ' ').slice(0, 600)}`).join('\n');
}

function prompt({ meta, profile, chapter, body, questions, research, mode, problems }) {
  const { company } = splitRoleKey((meta.roleKeys || [])[0] || `${meta.company || 'The company'}|${meta.role || 'the role'}`);
  const role = (meta.roleKeys || []).map((k) => splitRoleKey(k).role).join(' / ') || meta.role || 'the role';
  return renderTemplate(read(path.join(REF_DIR, 'agents', 'restructurer.md')), {
    targetFile: `${chapter.id}.body.md`, chapterId: chapter.id, mode, chapterTitle: chapter.title,
    role, company: meta.company || company, chapterBody: body, questions, research,
    styleGuide: renderStyleGuide(profile, meta), formatSpec: formatSpec(),
    fixSection: problems.length ? `## Fix these problems in your previous draft\n\nYour last draft is \`${chapter.id}.body.md\` in the current directory. Fix these and keep everything else:\n\n${problems.map((p) => `- ${p}`).join('\n')}` : '',
  });
}

function refreshDerived(dataDir, id) {
  const dir = store.wbDir(dataDir, id);
  const parsed = parseContentDir(path.join(dir, 'content'));
  store.writeJsonAtomic(path.join(dir, 'lint.json'), lintWorkbook({ files: parsed.files, glossaryFiles: parsed.glossaryFiles }, { allowMissingTests: true }));
  store.writeJsonAtomic(path.join(dir, 'glossary.json'), mergeGlossaries(parsed.glossaryFiles, store.nolinkFor(store.readMeta(dataDir, id))));
}

function createRestructureHandler(deps = {}) {
  const { dataDir } = deps;
  const now = deps.now || (() => new Date());
  const runAgent = deps.runAgent || require('../jobs/runner').runAgent;
  const readProfile = deps.readProfile || ((d) => readJson(path.join(d, 'profile.json'), {}));
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;

  return async function handleRestructureJob(job, ctx = { update() {} }) {
    const id = job && job.payload && job.payload.workbookId;
    const meta = store.isValidId(id) ? store.readMeta(dataDir, id) : null;
    if (!meta) throw new Error(`workbook ${id} not found`);
    const dir = store.wbDir(dataDir, id);
    const scratch = path.join(dir, 'drafts'); // run-agent.sh fences writes to this folder
    fs.mkdirSync(scratch, { recursive: true });
    const only = Array.isArray(job.payload.chapters) ? new Set(job.payload.chapters) : null;
    const todo = candidates(dataDir, id).filter((c) => !only || only.has(c.id));
    const state = { status: 'running', startedAt: now().toISOString(), chapters: Object.fromEntries(todo.map((c) => [c.id, { title: c.title, status: 'pending' }])) };
    writeState(dataDir, id, state);
    const research = guide.guideInputs(dataDir, id).source;
    const profile = readProfile(dataDir);

    for (const c of todo) {
      const entry = state.chapters[c.id];
      entry.status = 'writing';
      writeState(dataDir, id, state);
      if (ctx && ctx.update) ctx.update({ workbookId: id, chapter: c.id });
      const file = path.join(dir, 'content', c.file);
      const original = read(file);
      const loc = locate(original, c.id);
      const parsed = parseContentDir(path.join(dir, 'content'));
      const draft = path.join(scratch, `${c.id}.body.md`);
      fs.rmSync(draft, { force: true });
      let problems = [];
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        await runAgent({
          agent: `restructure-${c.id}${attempt ? '-fix' : ''}`, profile: 'write', cwd: scratch, timeoutMs,
          logFile: path.join(dir, 'logs', 'restructure.log'),
          prompt: prompt({ meta, profile, chapter: c, body: loc.body, questions: questionsText(parsed, c.id), research, mode: attempt ? 'fix' : 'write', problems }),
        });
        const body = read(draft);
        if (body === null) { problems = [`${c.id}.body.md was not written`]; continue; }
        problems = /^@@/m.test(body) ? ['Remove every line that starts with `@@`; write the chapter body only.'] : structureProblems(loc.header, body);
        if (problems.length) continue;
        const next = splice(original, c.id, body);
        const all = parseContentDir(path.join(dir, 'content')).files.map((f) => (f.name === c.file ? { name: f.name, text: next } : f));
        const errs = lintWorkbook({ files: all }, { allowMissingTests: true }).filter((f) => f.severity === 'error' && f.file === c.file && !/^glossary/.test(f.rule));
        const before = lintWorkbook({ files: parseContentDir(path.join(dir, 'content')).files }, { allowMissingTests: true }).filter((f) => f.severity === 'error' && f.file === c.file).length;
        if (errs.length > before) { problems = errs.map((f) => f.message); continue; }
        const backups = path.join(dir, 'backups');
        fs.mkdirSync(backups, { recursive: true });
        fs.writeFileSync(path.join(backups, `${c.file}.${now().toISOString().replace(/[:.]/g, '-')}`), original);
        fs.writeFileSync(file, next);
        fs.rmSync(draft, { force: true });
        done = true;
      }
      Object.assign(entry, done ? { status: 'rewritten', at: now().toISOString() } : { status: 'failed', error: problems.join(' ') });
      writeState(dataDir, id, state);
    }
    refreshDerived(dataDir, id);
    const failed = Object.values(state.chapters).filter((x) => x.status === 'failed').length;
    Object.assign(state, { status: failed ? 'partial' : 'done', finishedAt: now().toISOString() });
    writeState(dataDir, id, state);
    store.writeMeta(dataDir, { ...store.readMeta(dataDir, id) });
    return { workbookId: id, rewritten: todo.length - failed, failed };
  };
}

module.exports = { jobKey, readState, candidates, locate, splice, structureProblems, createRestructureHandler };
