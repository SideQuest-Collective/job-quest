// app/lib/workbook/steps-chapters.js
const fs = require('fs');
const path = require('path');
const store = require('./store');
const prompts = require('./prompts');
const { parseTexts, parseContentDir } = require('./parse');
const { lintWorkbook } = require('./lint');
const { mergeGlossaries } = require('./glossary');
const { headerLines } = require('./outline');

async function mapLimit(items, limit, fn) {
  let next = 0;
  let firstErr = null;
  const worker = async () => {
    while (!firstErr && next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (err) { if (!firstErr) firstErr = err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstErr) throw firstErr;
}

function readIf(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}
function draftPath(env, name) { return path.join(env.dir, 'drafts', name); }
function researchText(env) { return readIf(path.join(env.dir, 'research.md')) || ''; }

function runChapters(env, status) {
  return Object.values(env.state.chapters)
    .filter((c) => c.run === env.state.runId && c.status === status)
    .sort((a, b) => a.nn.localeCompare(b.nn));
}

function outlineEntry(env, id) {
  const outline = store.readJsonFile(path.join(env.dir, 'outline.json'), { chapters: [] });
  const entry = (outline.chapters || []).find((c) => c.id === id);
  if (!entry) throw new Error(`outline.json has no chapter "${id}"`);
  return entry;
}

function checkDraft(env, rec, plan) {
  const text = readIf(draftPath(env, rec.file));
  if (text === null) return [`${rec.file} was not written`];
  const gloss = readIf(draftPath(env, rec.glossaryFile));
  const published = parseContentDir(path.join(env.dir, 'content'));
  // The draft goes last so a clash with a published id is reported against the draft.
  const files = [...published.files.filter((f) => f.name !== rec.file), { name: rec.file, text }];
  const problems = lintWorkbook({ files, glossaryFiles: gloss === null ? [] : [{ name: rec.glossaryFile, text: gloss }] })
    .filter((f) => f.severity === 'error' && (f.file === rec.file || f.file === rec.glossaryFile))
    .map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`);
  if (gloss === null) problems.push(`${rec.glossaryFile} was not written`);
  const expected = headerLines(plan);
  const actual = text.replace(/\r/g, '').split('\n').filter((l) => /^@@(chapter|q)\s/.test(l)).map((l) => l.trimEnd());
  if (actual.join('\n') !== expected.join('\n')) problems.push(`the directive lines must be exactly these, in this order:\n${expected.join('\n')}`);
  return problems;
}

async function verifyDraft(env, rec) {
  const text = readIf(draftPath(env, rec.file)) || '';
  const { questions } = parseTexts([{ name: rec.file, text }]);
  const out = [];
  for (const q of questions.filter((x) => x.type === 'code')) out.push(await env.verify(q));
  return out;
}

function failing(results) { return results.filter((r) => !r.pass && !r.unverified); }

function verifyErrors(results) {
  return failing(results).map((r) => `${r.qid}: ${r.failures.map((f) => (f.error
    ? `case ${f.case}: ${f.error}`
    : `case ${f.case}: expected ${JSON.stringify(f.expected)}, got ${f.actual}`)).join('; ')}`);
}

function runWriter(env, rec, plan, fix) {
  return env.runAgent({
    agent: `writer-${rec.id}`,
    prompt: prompts.writerPrompt({ meta: env.getMeta(), chapter: plan, research: researchText(env), profile: env.profile, fix }),
    cwd: path.join(env.dir, 'drafts'), profile: 'write', timeoutMs: env.timeouts.writer, logFile: env.logFile(`writer-${rec.id}`),
  });
}

async function write(env) {
  fs.mkdirSync(path.join(env.dir, 'drafts'), { recursive: true });
  await mapLimit(runChapters(env, 'pending'), env.writerConcurrency, async (rec) => {
    const plan = outlineEntry(env, rec.id);
    while (rec.attempts < 2) {
      const fix = rec.attempts > 0 ? { kind: 'lint', errors: rec.lint } : null;
      const r = await runWriter(env, rec, plan, fix);
      // In-flight work must not spend an attempt if the process crashes.
      rec.attempts += 1;
      const problems = checkDraft(env, rec, plan);
      if (!r.ok && problems.length) problems.unshift(r.timedOut ? 'the writer timed out' : `the writer exited with code ${r.code}`);
      rec.lint = problems;
      if (!problems.length) {
        rec.status = 'written';
        rec.error = null;
        env.save();
        env.emit(`chapter:written:${rec.id}`);
        return;
      }
      env.save();
    }
    rec.status = 'failed';
    rec.error = `did not pass the format checks after ${rec.attempts} attempts`;
    env.save();
    env.emit(`chapter:failed:${rec.id}`);
  });
}

async function verify(env) {
  for (const rec of runChapters(env, 'written')) {
    const plan = outlineEntry(env, rec.id);
    let results = await verifyDraft(env, rec);
    if (failing(results).length && rec.fixRounds < 1) {
      await runWriter(env, rec, plan, { kind: 'verify', errors: verifyErrors(results) });
      rec.fixRounds += 1;
      env.save();
      const problems = checkDraft(env, rec, plan);
      if (problems.length) {
        rec.status = 'failed';
        rec.lint = problems;
        rec.error = 'the code fix broke the format checks';
        env.save();
        env.emit(`chapter:failed:${rec.id}`);
        continue;
      }
      results = await verifyDraft(env, rec);
    }
    rec.verify = results;
    if (failing(results).length) {
      rec.status = 'failed';
      rec.error = 'a reference solution still fails its own tests after one fix round';
    } else {
      rec.status = 'verified';
    }
    env.save();
    env.emit(`chapter:${rec.status}:${rec.id}`);
  }
  const chapters = {};
  for (const c of Object.values(env.state.chapters)) if (c.verify && c.verify.length) chapters[c.id] = c.verify;
  store.writeJsonAtomic(path.join(env.dir, 'verify.json'), { checkedAt: new Date(env.now()).toISOString(), chapters });
}

async function review(env) {
  const backupDir = path.join(env.dir, '.prereview');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(draftPath(env, '.review'), { recursive: true });
  await mapLimit(runChapters(env, 'verified'), env.writerConcurrency, async (rec) => {
    const plan = outlineEntry(env, rec.id);
    const files = [rec.file, rec.glossaryFile];
    for (const f of files) {
      const backup = path.join(backupDir, f);
      // A backup left by a crashed review is the verified copy: start from it.
      if (fs.existsSync(backup)) fs.copyFileSync(backup, draftPath(env, f));
      else fs.copyFileSync(draftPath(env, f), backup);
    }
    const reviewRel = path.join('.review', `${rec.id}.json`);
    fs.writeFileSync(draftPath(env, reviewRel), JSON.stringify({ chapterId: rec.id, verdict: '', edits: [], concerns: [] }, null, 2));
    const r = await env.runAgent({
      agent: `editor-${rec.id}`,
      prompt: prompts.editorPrompt({ meta: env.getMeta(), chapter: plan, profile: env.profile, reviewFile: reviewRel }),
      cwd: path.join(env.dir, 'drafts'), profile: 'edit', timeoutMs: env.timeouts.editor, logFile: env.logFile(`editor-${rec.id}`),
    });
    let reason = null;
    const problems = checkDraft(env, rec, plan);
    if (problems.length) {
      reason = problems[0];
    } else {
      const v = await verifyDraft(env, rec);
      if (failing(v).length) reason = `the edit broke a reference solution: ${verifyErrors(v)[0]}`;
      else rec.verify = v;
    }
    if (reason) for (const f of files) fs.copyFileSync(path.join(backupDir, f), draftPath(env, f));
    const raw = store.readJsonFile(draftPath(env, reviewRel), null);
    const valid = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    const findings = {
      chapterId: rec.id,
      verdict: valid && typeof raw.verdict === 'string' ? raw.verdict : '',
      edits: valid && Array.isArray(raw.edits) ? raw.edits : [],
      concerns: !valid ? ['malformed review'] : Array.isArray(raw.concerns) ? raw.concerns : [],
    };
    rec.review = { ok: r.ok, reverted: !!reason, reason, findings };
    rec.status = 'reviewed';
    env.save();
    for (const f of files) fs.rmSync(path.join(backupDir, f), { force: true });
    env.emit(`chapter:reviewed:${rec.id}`);
  });
  const chapters = {};
  for (const c of Object.values(env.state.chapters)) if (c.review) chapters[c.id] = c.review;
  store.writeJsonAtomic(path.join(env.dir, 'review.json'), { chapters });
}

async function glossary(env) {
  const meta = env.getMeta();
  const published = parseContentDir(path.join(env.dir, 'content')).glossaryFiles;
  const drafts = runChapters(env, 'reviewed').map((rec) => ({ name: rec.glossaryFile, text: readIf(draftPath(env, rec.glossaryFile)) || '' }));
  const byName = new Map();
  for (const f of [...published, ...drafts]) byName.set(f.name, f);
  const files = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  store.writeJsonAtomic(path.join(env.dir, 'glossary.json'), mergeGlossaries(files, store.nolinkFor(meta)));
}

async function publish(env) {
  const contentDir = path.join(env.dir, 'content');
  const failedDir = path.join(env.dir, 'failed');
  fs.mkdirSync(contentDir, { recursive: true });
  const recs = Object.values(env.state.chapters).filter((c) => c.run === env.state.runId).sort((a, b) => a.nn.localeCompare(b.nn));
  for (const rec of recs) {
    if (rec.status === 'reviewed') {
      // Another editor may have changed this draft after its own review finished.
      const problems = checkDraft(env, rec, outlineEntry(env, rec.id));
      let reason = problems[0];
      if (!reason) {
        rec.verify = await verifyDraft(env, rec);
        if (failing(rec.verify).length) reason = `a reference solution failed before publish: ${verifyErrors(rec.verify)[0]}`;
      }
      if (reason) {
        rec.status = 'failed';
        rec.lint = problems;
        rec.error = reason;
        env.save();
        env.emit(`chapter:failed:${rec.id}`);
      }
    }
    if (rec.status === 'reviewed') {
      for (const f of [rec.file, rec.glossaryFile]) {
        const from = draftPath(env, f);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(contentDir, f));
      }
      rec.status = 'published';
      env.save();
      env.emit(`chapter:published:${rec.id}`);
    } else if (rec.status === 'failed') {
      fs.mkdirSync(failedDir, { recursive: true });
      for (const f of [rec.file, rec.glossaryFile]) {
        const from = draftPath(env, f);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(failedDir, f));
      }
    }
  }
  env.setMeta({ unreviewedChapters: Object.values(env.state.chapters)
    .filter(c => c.status === 'published' && c.review && c.review.ok === false).length });
}

module.exports = { write, verify, review, glossary, publish, mapLimit, checkDraft };
