const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const workbook = require('../workbook/store');
const catalog = require('./catalog');
const { practiceCheck, hashing } = require('./recommendations');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const text = (v, label, max = 100000, optional = false) => {
  if (typeof v !== 'string' || v.length > max || (!optional && !v.trim())) fail(`${label} must be ${optional ? '' : 'nonempty '}text (maximum ${max} characters)`);
  return v;
};
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function load(dataDir) {
  const state = read(path.join(dataDir, 'learning', 'workspace.json'), { version: 1, revision: 0, sources: [], sessions: [] });
  if (state.version !== 1 || !Number.isInteger(state.revision) || !Array.isArray(state.sources) || !Array.isArray(state.sessions)) fail('Learning data is unreadable; existing data has not been changed.', 500);
  return state;
}
function mutate(dataDir, revision, fn) {
  const state = load(dataDir);
  if (!Number.isInteger(revision) || revision !== state.revision) fail('This page is out of date. Reload saved data before trying again; your text is still in this page.', 409);
  fn(state);
  state.revision++;
  const dir = path.join(dataDir, 'learning');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'workspace.json');
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return state;
}
function saveSource(dataDir, body) {
  return mutate(dataDir, body.revision, (state) => {
    const s = body.source || {};
    if (!['concept', 'resume', 'story', 'company'].includes(s.kind)) fail('Choose concept, resume, story or company.');
    const sourcePath = text(s.path, 'Source path', 500).trim().replace(/\\/g, '/');
    if (sourcePath.includes('\0') || sourcePath.split('/').includes('..')) fail('Use a stable source path without parent traversal.');
    const title = text(s.title, 'Title', 300).trim();
    const content = text(s.content, 'Source content');
    const roleKey = s.kind === 'company' ? text(s.roleKey, 'Company|Role', 300).trim() : null;
    if (roleKey && !/^[^|]+\|[^|]+$/.test(roleKey)) fail('Company sources need a Company|Role identity.');
    // Matches interview preparation's concept:<path> identity, while keeping background separate.
    const id = `${s.kind}:${sourcePath}`;
    const old = state.sources.find((item) => item.id === id);
    const sha256 = hash(content);
    if (old && old.sha256 !== sha256 && (body.confirmRefresh !== true || body.previousHash !== old.sha256)) fail('This source has changed. Review the current snapshot and explicitly confirm its replacement.', 409);
    const next = { id, kind: s.kind, path: sourcePath, resolvedPath: s.resolvedPath ? text(s.resolvedPath, 'Resolved path', 1000) : null,
      title, content, sha256, roleKey, createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (old) state.sources[state.sources.indexOf(old)] = next; else state.sources.push(next);
    // Attempts retain their source snapshots; refreshing a reference cannot rewrite evidence.
  });
}
function saveSession(dataDir, body, { getLinkedSources = () => ({ sources: [], available: false }) } = {}) {
  return mutate(dataDir, body.revision, (state) => {
    const s = body.session || {};
    if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{6,100}$/.test(s.id)) fail('Invalid session identity.');
    if (!['retrieval', 'media'].includes(s.kind)) fail('Invalid session kind.');
    if (![5, 15, 30].includes(s.minutes)) fail('Choose 5, 15 or 30 minutes.');
    if (!['draft', 'answered'].includes(s.status)) fail('Invalid answer state.');
    const response = text(s.response, 'Response', 30000, s.status === 'draft');
    const old = state.sessions.find((item) => item.id === s.id);
    if (old?.status === 'answered') fail('An answered attempt is preserved. Start another attempt to add new evidence.', 409);
    if (old && ['kind', 'sourceId', 'prompt', 'goal'].some((key) => old[key] !== s[key])) fail('This draft belongs to a different activity or reference. Start a new attempt instead of changing its identity.', 409);
    const sourceOrigin = s.sourceOrigin || 'saved';
    if (!['saved', 'linked'].includes(sourceOrigin)) fail('Invalid reference origin.');
    if (old && (old.sourceOrigin || 'saved') !== sourceOrigin) fail('This draft belongs to a different reference origin. Start a new attempt.', 409);
    const sourceId = text(s.sourceId, 'Source identity', 600);
    let source;
    if (sourceOrigin === 'linked') {
      if (old?.sourceSnapshot) source = { ...old.sourceSnapshot, kind: 'concept' };
      else {
        const current = getLinkedSources();
        if (!current.available) fail('Shared interview references could not be read. Your text is still here; reload the linked references before saving.', 409);
        source = current.sources.find((item) => item.id === sourceId);
      }
    } else source = state.sources.find((item) => item.id === sourceId);
    if (sourceOrigin === 'linked' && !source) fail('This shared reference is unavailable. Reload linked references before saving.', 409);
    const media = catalog.find((item) => item.id === sourceId);
    if (!source && !media && sourceId !== 'builtin:hashing' && sourceId !== practiceCheck.id) fail('This reference no longer exists; reload the page.', 409);
    if (s.kind === 'retrieval' && source && source.kind !== 'concept') fail('Only concepts are retrieval references; resume, company and story sources remain background.');
    if (s.kind === 'retrieval' && media) fail('Use a media reflection for audio or video.');
    if (s.kind === 'media' && !media) fail('Choose a media resource.');
    if (source && !old && s.sourceHash !== source.sha256) fail('The reference changed while this answer was open. Your text was kept; start from the updated reference to record a new attempt.', 409);
    if (!Number.isFinite(s.positionSeconds || 0) || (s.positionSeconds || 0) < 0 || (s.positionSeconds || 0) > 86400) fail('Playback position must be between 0 and 86400 seconds.');
    let planContext = old?.planContext || null;
    if (!old && s.planContext) {
      const c = s.planContext;
      if (c.href != null && (typeof c.href !== 'string' || !/^\/(?:\?problem=[^#\s]+|\?sd=[^#\s]+|workbooks\/[^\s]+|#(?:codelab|sysdesign|behavioral|trainer|workbooks))$/.test(c.href))) fail('Choose a local practice destination.');
      planContext = { choiceId: text(c.choiceId, 'Practice identity', 600), title: text(c.title, 'Practice title', 1000),
        ...(c.href ? { href: c.href } : {}), ...(c.reason ? { reason: text(c.reason, 'Practice reason', 1000) } : {}),
        ...(c.planId ? { planId: text(c.planId, 'Plan identity', 100) } : {}),
        ...(c.feedbackAttemptId ? { feedbackAttemptId: text(c.feedbackAttemptId, 'Feedback identity', 150) } : {}) };
    }
    if (old && ['choiceId', 'title', 'href', 'reason', 'planId', 'feedbackAttemptId'].some(key => (old.planContext?.[key] || null) !== (s.planContext?.[key] || null))) fail('This draft belongs to a different practice goal. Resume its saved context or start a new attempt.', 409);
    const next = { id: s.id, kind: s.kind, minutes: s.minutes, status: s.status, response, planContext,
      goal: text(s.goal, 'Goal', 1000), sourceId, sourceOrigin, sourceHash: old?.sourceHash || source?.sha256 || null, prompt: text(s.prompt, 'Prompt', 2000),
      sourceSnapshot: old?.sourceSnapshot || ([practiceCheck.id, hashing.id].includes(sourceId) ? { id: sourceId, content: (sourceId === hashing.id ? hashing : practiceCheck).content, sha256: hash((sourceId === hashing.id ? hashing : practiceCheck).content) } : source ? { id: source.id, path: source.path, physicalPath: source.physicalPath || null, resolvedPath: source.resolvedPath || null, sha256: source.sha256, content: source.content } : null),
      mediaSnapshot: old?.mediaSnapshot || (media ? { id: media.id, title: media.title, url: media.url, goal: media.goal, publisher: media.publisher } : null),
      assisted: old?.assisted === true || s.assisted === true || !!planContext?.feedbackAttemptId, revealed: old?.revealed === true || s.revealed === true,
      positionSeconds: s.positionSeconds || 0, feedback: { status: 'ungraded', score: null },
      createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (old) state.sessions[state.sessions.indexOf(old)] = next; else state.sessions.push(next);
  });
}
function existingReferences(dataDir) {
  const legacy = read(path.join(dataDir, 'concepts', 'library.json'), { concepts: [] });
  if (!Array.isArray(legacy.concepts)) fail('Existing concept library is unreadable; it has not been changed.', 500);
  return legacy.concepts.filter((s) => s && typeof s.body === 'string' && typeof s.source?.path === 'string' && (
    s.source.path === 'resources/coding-patterns.md' || /^resources\/cheatsheets\/[^/]+\.md$/i.test(s.source.path) || /^stories\/[^/]+\.md$/i.test(s.source.path)
  ) && !/(?:\/README|context)\.md$/i.test(s.source.path)).map((s) => {
    const sourcePath = s.source.path;
    const kind = sourcePath.startsWith('stories/') ? 'story' : 'concept';
    return { id: `${kind}:${sourcePath}`, kind, path: sourcePath, title: s.title || sourcePath, content: s.body, sha256: hash(s.body),
      legacyId: s.id, createdAt: s.createdAt || new Date().toISOString(), updatedAt: s.updatedAt || new Date().toISOString() };
  });
}
function importExisting(dataDir, body) {
  const available = existingReferences(dataDir);
  return mutate(dataDir, body.revision, (state) => {
    // Existing snapshots and user edits always win. Changed imports require explicit refresh.
    for (const source of available) if (!state.sources.some((s) => s.id === source.id)) state.sources.push(source);
  });
}
function quickChoices(dataDir, getProblems, { now = new Date() } = {}) {
  const choices = []; const warnings = []; let problems = []; let progress = {};
  const safely = (label, fn) => { try { fn(); } catch { warnings.push(`${label} could not be read. Open its native page to inspect it.`); } };
  safely('Code Lab', () => {
    progress = read(path.join(dataDir, 'problems', 'progress.json'), {});
    problems = getProblems ? getProblems().problems || [] : read(path.join(dataDir, 'problems', 'problems.json'), { problems: [] }).problems;
    for (const p of problems || []) if (!progress.solved?.[p.id]) choices.push({ id: `code:${p.id}`, title: p.title, category: 'coding', minutes: 30,
      href: `/?problem=${encodeURIComponent(p.id)}`, statement: p.description, tags: p.tags || [], saved: !!progress.savedCode?.[p.id],
      reason: progress.savedCode?.[p.id] ? 'Continue your saved code' : 'Practice in Code Lab with tests and feedback', rank: progress.savedCode?.[p.id] ? 0 : 5 });
  });
  safely('Workbooks', () => {
    for (const wb of workbook.listWorkbooks(dataDir)) {
      const p = workbook.readProgress(dataDir, wb.id);
      const parsed = workbook.loadParsed(dataDir, wb.id);
      const unfinished = parsed.questions.filter((q) => !p.grades[q.id]);
      if (!unfinished.length) continue;
      const saved = unfinished.some(q => typeof p.answers[q.id] === 'string' && p.answers[q.id].trim());
      choices.push({ id: `workbook:${wb.id}`, title: wb.title, category: 'workbook', minutes: 15, saved,
        href: `/workbooks/${encodeURIComponent(wb.id)}${p.lastChapter ? `#read/${encodeURIComponent(p.lastChapter)}` : ''}`,
        reason: saved ? 'Continue saved ungraded workbook answers' : `${unfinished.length} questions without a grade`, rank: saved ? 1 : 4 });
    }
  });
  safely('Daily Tasks', () => {
    const dir = path.join(dataDir, 'tasks'); if (!fs.existsSync(dir)) return;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const f of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse()) {
      if (f.slice(0, 10) > today) continue;
      const day = read(path.join(dir, f), {});
      for (const [i, t] of (day.tasks || []).entries()) {
        if (!t || t.completed) continue;
        const l = t.link || {}; let href = null;
        if (l.kind === 'workbook' && l.workbookId) href = `/workbooks/${encodeURIComponent(l.workbookId)}${l.chapter ? `#read/${encodeURIComponent(l.chapter)}` : ''}`;
        if (l.kind === 'codelab' && l.problemId) href = `/?problem=${encodeURIComponent(l.problemId)}`;
        if (l.kind === 'sysdesign' && l.topicId) href = `/?sd=${encodeURIComponent(l.topicId)}`;
        if (!href && t.problemId) href = `/?problem=${encodeURIComponent(t.problemId)}`;
        if (!href && t.category === 'behavioral') href = '/#behavioral';
        const problem = problems.find(p => p.id === (l.problemId || t.problemId));
        if (problem && progress.solved?.[problem.id]) continue;
        if (href) choices.push({ id: `task:${f}:${i}`, title: t.text, category: t.category, minutes: t.minutes || 15, href,
          tags: problem?.tags || [], statement: problem?.description, saved: !!progress.savedCode?.[problem?.id], planId: t.planId || null,
          date: f.slice(0, 10), reason: `${t.planId ? 'Your plan' : 'Unfinished task'} · ${f.slice(0, 10)}${f.slice(0, 10) === today ? ' · today' : ' · earlier session'}`, rank: f.slice(0, 10) === today ? 0.5 : 2 });
      }
    }
  });
  // Merge an exact destination rather than showing its plan task and draft twice.
  const merged = new Map();
  for (const c of choices) {
    const key = c.href.startsWith('/#') ? c.id : c.href;
    const old = merged.get(key);
    if (!old) { merged.set(key, c); continue; }
    const preferred = c.date && (!old.date || c.date > old.date) ? c : old;
    const draft = c.saved || old.saved;
    merged.set(key, { ...preferred, saved: draft, rank: draft ? Math.min(c.rank, old.rank) : preferred.rank,
      reason: `${preferred.reason}${draft && !preferred.reason.includes('saved') ? ' · saved work' : ''}` });
  }
  return { choices: [...merged.values()].sort((a, b) => a.rank - b.rank).slice(0, 40), warnings };
}
module.exports = { load, saveSource, saveSession, quickChoices, hash, catalog, existingReferences, importExisting };
