// app/lib/resume/pipeline.js
const fs = require('fs');
const path = require('path');
const { runAgent } = require('../jobs/runner');
const { roleSlug } = require('../jobs/slug');
const { resolveRole } = require('../jobs/roles');
const { readSettings } = require('../jobs/settings');
const { readMaster, validateMaster, allMasterText, assignIds, emptyMaster } = require('./master');
const { buildLexicon, matchesAny } = require('./lexicon');
const { checkTailored } = require('./guard');
const { buildDocument, renderTex, compileTex, ensureTemplate } = require('./render');
const { gradePdf, loadTellWords } = require('./grade');
const { fetchJd } = require('./jdfetch');
const { renderPrompt, extractJson, verifyKeywords, keywordCountsOk } = require('./agents');
const { diffTailored, lineDiff } = require('./diff');

const TARGET = 90;
const MAX_ROUNDS = 3;
const ANALYST_TIMEOUT_MS = 5 * 60 * 1000;
const TAILOR_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_PASTED_JD = 200;
const ID_RE = /^[a-z0-9-]{1,90}$/;
const ACTIVE = new Set(['queued', 'running']);

class ServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function tail(s, n = 600) {
  const t = String(s || '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function expandInputs(file, depth = 0, root = path.dirname(file)) {
  const src = fs.readFileSync(file, 'utf-8');
  if (depth >= 3) return src;
  return src.split('\n').map((line) => {
    if (/^\s*%/.test(line)) return line;
    return line.replace(/\\(?:input|include)\{([^}]+)\}/g, (m, name) => {
      const p = path.resolve(root, name.endsWith('.tex') ? name : `${name}.tex`);
      if (!p.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(p)) return m;
      return expandInputs(p, depth + 1, root);
    });
  }).join('\n');
}

function createResumeService({ dataDir, queue = null, now = () => new Date(), deps = {} }) {
  const d = {
    runAgent: deps.runAgent || runAgent,
    fetchJd: deps.fetchJd || fetchJd,
    compileTex: deps.compileTex || compileTex,
    gradePdf: deps.gradePdf || gradePdf,
    resolveRole: deps.resolveRole || resolveRole,
    readSettings: deps.readSettings || readSettings,
  };
  const tailoredDir = path.join(dataDir, 'resume', 'tailored');
  const stamp = () => new Date(now()).toISOString();
  let tellWords = null;
  const tells = () => tellWords || (tellWords = loadTellWords());

  function recDir(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ServiceError(400, 'invalid id');
    return path.join(tailoredDir, id);
  }
  const metaFile = (id) => path.join(recDir(id), 'meta.json');
  const readMeta = (id) => readJson(metaFile(id));
  function patchMeta(id, patch) {
    const meta = { ...readMeta(id), ...patch, updatedAt: stamp() };
    writeJson(metaFile(id), meta);
    return meta;
  }
  function mustMeta(id) {
    const meta = fs.existsSync(recDir(id)) ? readMeta(id) : null;
    if (!meta) throw new ServiceError(404, 'tailored resume not found');
    return meta;
  }
  function listMeta() {
    if (!fs.existsSync(tailoredDir)) return [];
    return fs.readdirSync(tailoredDir)
      .filter((n) => ID_RE.test(n))
      .map((n) => readJson(path.join(tailoredDir, n, 'meta.json')))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
  }
  const activeFor = (roleKey) => listMeta().find((m) => (m.roleKeys || []).includes(roleKey) && m.status !== 'failed') || null;
  const fail = (id, error) => patchMeta(id, { status: 'failed', error, deferred: false });
  const maxRound = (meta) => (meta.rounds || []).reduce((m, r) => Math.max(m, r.n), 0);

  function requestTailor(roleKey, { trigger = 'manual', auto = false } = {}) {
    if (typeof roleKey !== 'string' || !roleKey.includes('|')) throw new ServiceError(400, 'roleKey must look like "Company|Role"');
    const existing = activeFor(roleKey);
    if (existing) return { meta: existing, created: false, queue: 'existing' };
    if (!queue) throw new Error('resume service was created without a queue');
    const role = d.resolveRole(dataDir, roleKey);
    fs.mkdirSync(tailoredDir, { recursive: true });
    const id = roleSlug(role.company, role.role, (s) => fs.existsSync(path.join(tailoredDir, s)));
    const t = stamp();
    writeJson(metaFile(id), {
      id, roleKeys: [roleKey], company: role.company, role: role.role, jdUrl: role.url || '',
      status: 'queued', bestRound: null, bestScore: null, accepted: false, acceptedAt: null, trigger,
      createdAt: t, updatedAt: t, error: null, deferred: false, gaps: null, rounds: [], runs: [],
    });
    const opts = auto ? { auto: true, capName: 'resume', cap: d.readSettings(dataDir).resume.autoDailyCap } : {};
    const r = queue.enqueue({ kind: 'resume', key: `resume:${id}`, payload: { id, mode: 'full' } }, opts);
    if (r.status === 'deferred') patchMeta(id, { deferred: true });
    return { meta: readMeta(id), created: true, queue: r.status };
  }

  function autoTailor(roleKey, trigger) {
    const s = d.readSettings(dataDir);
    if (!s.resume || s.resume.autoTailor === false) return { skipped: 'auto-tailor is off' };
    if (activeFor(roleKey)) return { skipped: 'already tailored or queued' };
    return requestTailor(roleKey, { trigger, auto: true });
  }

  function profileText() {
    const p = readJson(path.join(dataDir, 'profile.json'));
    if (!p) return 'No profile on file.';
    const s = JSON.stringify(p, null, 2);
    return s.length > 4000 ? `${s.slice(0, 4000)}\n…` : s;
  }

  const violationLines = (violations) => violations.slice(0, 20).map((v) => `- ${v.path || '(document)'} [rule ${v.rule}]: ${v.detail}`);

  function fixNote(guard) {
    return ['## Fix these problems from your previous attempt in this round', ...violationLines(guard.violations), 'Return the whole corrected JSON.'].join('\n');
  }

  function previousSummary(id, meta) {
    const rounds = meta.rounds || [];
    const last = rounds[rounds.length - 1];
    if (!last) return '';
    const rdir = path.join(recDir(id), `round-${last.n}`);
    if (last.status !== 'scored') {
      const g = readJson(path.join(rdir, 'guard.json'), { violations: [] });
      return [`## Previous round (round ${last.n}) was discarded`, `Reason: ${last.reason}`, ...violationLines(g.violations || [])].join('\n');
    }
    const s = readJson(path.join(rdir, 'score.json'), {});
    const c = s.categories || {};
    const kw = s.keywords || {};
    const failed = (s.checks || []).filter((x) => !x.pass).map((x) => `${x.cat}/${x.id}${x.detail ? ` (${x.detail})` : ''}`);
    const list = (a) => ((a || []).length ? a.join(', ') : 'none');
    return [
      `## Previous round (round ${last.n}, score ${s.total}/100)`,
      `- Category scores: K ${c.K}/30, P ${c.P}/30, S ${c.S}/15, H ${c.H}/15, C ${c.C}/10`,
      `- Required keywords still missing: ${list(kw.requiredMiss)}`,
      `- Preferred keywords missing: ${list(kw.preferredMiss)}`,
      `- Keywords used more than 3 times: ${list(kw.stuffed)}`,
      `- Failed checks: ${failed.length ? failed.join('; ') : 'none'}`,
      `- AI tells found: ${list(s.tells)}`,
      `- Words: ${s.words}, pages: ${s.pages}`,
      'Improve on these without breaking the hard rules. A missing keyword the master does not support must stay missing.',
    ].join('\n');
  }

  async function analyze(id, meta, jd) {
    let note = '';
    let last = null;
    let best = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await d.runAgent({
          agent: 'jd-analyst', prompt: renderPrompt('jd-analyst', { company: meta.company, role: meta.role, jd, retryNote: note }),
          cwd: recDir(id), profile: 'read', timeoutMs: ANALYST_TIMEOUT_MS, logFile: path.join(recDir(id), 'agents.log'),
        });
      } catch (err) {
        last = { error: `JD analyst failed: ${err.message}` };
        note = '';
        continue;
      }
      if (!r.ok) { last = { error: `JD analyst failed (${r.timedOut ? 'timed out' : `exit ${r.code}`})` }; note = ''; continue; }
      const parsed = extractJson(r.stdout);
      if (!parsed.ok) {
        last = { error: `JD analyst: ${parsed.error}` };
        note = `## Your previous reply could not be parsed\n${parsed.error}. Reply with only the JSON code fence.`;
        continue;
      }
      const k = verifyKeywords(parsed.value, jd);
      if (keywordCountsOk(k)) return { ok: true, keywords: { title: k.title || meta.role, required: k.required, preferred: k.preferred } };
      if (k.required.length >= 8 && (!best || k.required.length > best.required.length)) best = k;
      last = k;
      note = [
        '## Fix the counts',
        `After checking your terms against the job description, ${k.required.length} required and ${k.preferred.length} preferred terms remained${k.dropped.length ? ` (dropped because they are not in the text: ${k.dropped.join(', ')})` : ''}.`,
        'Return 8 to 20 required terms and at most 15 preferred terms, each spelled exactly as it appears in the job description.',
      ].join('\n');
    }
    if (best) {
      return { ok: true, keywords: { title: best.title || meta.role, required: best.required.slice(0, 20), preferred: best.preferred.slice(0, 15) } };
    }
    if (last && Array.isArray(last.required)) {
      return { ok: false, error: `the JD analyst found only ${last.required.length} verified required keywords (need at least 8). Paste a fuller job description, then retry.` };
    }
    return { ok: false, error: (last && last.error) || 'the JD analyst failed' };
  }

  async function runRound({ id, n, master, keywords, jd, meta, template, lexicon }) {
    const dir = recDir(id);
    const rdir = path.join(dir, `round-${n}`);
    fs.rmSync(rdir, { recursive: true, force: true });
    fs.mkdirSync(rdir, { recursive: true });
    const { meta: _ignored, contact: _contact, ...masterForPrompt } = master;
    const base = {
      company: meta.company, role: meta.role, round: String(n), jd,
      keywords: JSON.stringify(keywords, null, 2), master: JSON.stringify(masterForPrompt, null, 2),
      profile: profileText(), previous: previousSummary(id, meta), tells: tells().join(', '),
    };
    let fix = '';
    let tailored = null;
    let guard = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await d.runAgent({
        agent: 'tailor', prompt: renderPrompt('tailor', { ...base, retryNote: fix }),
        cwd: dir, profile: 'read', timeoutMs: TAILOR_TIMEOUT_MS, logFile: path.join(dir, 'agents.log'),
      });
      const parsed = r.ok ? extractJson(r.stdout) : { ok: false, error: r.timedOut ? 'the tailor timed out' : `the tailor exited with code ${r.code}` };
      if (parsed.ok) {
        tailored = parsed.value;
        guard = checkTailored(master, tailored, { lexicon, keywords });
        writeJson(path.join(rdir, 'tailored.json'), tailored);
      } else {
        tailored = null;
        guard = { pass: false, violations: [{ path: '', rule: 'schema', detail: parsed.error }] };
      }
      writeJson(path.join(rdir, 'guard.json'), guard);
      if (guard.pass) break;
      fix = fixNote(guard);
    }
    if (!guard.pass) {
      const k = guard.violations.length;
      return { n, status: 'discarded', reason: `fact guard (${k} violation${k === 1 ? '' : 's'})`, score: null };
    }
    const texPath = path.join(rdir, 'resume.tex');
    fs.writeFileSync(texPath, renderTex(template, buildDocument(master, tailored)));
    let c;
    try {
      c = await d.compileTex({ texPath });
    } catch (err) {
      c = { ok: false, log: String(err.message || err) };
    }
    if (!c.ok) {
      fs.writeFileSync(path.join(rdir, 'compile.log'), c.log || '');
      return { n, status: 'discarded', reason: `compile failed: ${tail(c.log, 300)}`, score: null };
    }
    frozenKeywords(id);
    const score = await d.gradePdf(c.pdfPath, { keywords, master, tellWords: tells() });
    writeJson(path.join(rdir, 'score.json'), score);
    return { n, status: 'scored', reason: null, score: score.total };
  }

  function computeGaps(master, keywords, score) {
    const text = allMasterText(master);
    const missing = (score.keywords && score.keywords.requiredMiss) || [];
    const byTerm = new Map((keywords.required || []).map((k) => [k.term, k]));
    const unsupported = missing.filter((t) => {
      const k = byTerm.get(t) || { term: t, alts: [] };
      return !matchesAny(text, [k.term, ...(k.alts || [])]);
    });
    return { missing, unsupported };
  }

  function finish(id, master, keywords) {
    const meta = readMeta(id);
    const scored = (meta.rounds || []).filter((r) => r.status === 'scored');
    if (!scored.length) {
      const why = (meta.rounds || []).map((r) => `round ${r.n}: ${r.reason}`).join('; ');
      return patchMeta(id, { status: 'failed', error: `no round produced a gradable resume (${why})`, bestRound: null, bestScore: null });
    }
    const best = scored.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.n < a.n) ? b : a));
    const dir = recDir(id);
    fs.copyFileSync(path.join(dir, `round-${best.n}`, 'resume.pdf'), path.join(dir, 'resume.pdf'));
    const score = readJson(path.join(dir, `round-${best.n}`, 'score.json'), {});
    return patchMeta(id, {
      status: best.score >= TARGET ? 'done' : 'below-target',
      bestRound: best.n, bestScore: best.score, error: null, gaps: computeGaps(master, keywords, score),
    });
  }

  function frozenKeywords(id) {
    const keywords = readJson(path.join(recDir(id), 'keywords.json'));
    if (!keywords || !Array.isArray(keywords.required) || !keywords.required.length) {
      throw new Error('keywords missing');
    }
    return keywords;
  }

  async function runJob(job, ctx = { update() {} }) {
    const { id, mode = 'full' } = (job && job.payload) || {};
    if (typeof id !== 'string' || !ID_RE.test(id) || !readMeta(id)) return { skipped: 'record deleted' };
    try {
      let meta = patchMeta(id, { status: 'running', error: null, deferred: false });
      const dir = recDir(id);
      const jdFile = path.join(dir, 'jd.txt');
      const kwFile = path.join(dir, 'keywords.json');
      if (!fs.existsSync(jdFile)) {
        ctx.update({ step: 'fetch' });
        const url = meta.jdUrl || d.resolveRole(dataDir, meta.roleKeys[0]).url || '';
        const r = await d.fetchJd(url);
        if (!r.ok) return fail(id, `posting unavailable: ${r.reason}. Paste the job description to continue.`);
        fs.writeFileSync(jdFile, r.text);
        meta = patchMeta(id, { jdUrl: url });
      }
      const jd = fs.readFileSync(jdFile, 'utf-8');
      if (!fs.existsSync(kwFile)) {
        if ((meta.runs || []).length || (meta.rounds || []).length) return fail(id, 'keywords missing');
        ctx.update({ step: 'keywords' });
        const k = await analyze(id, meta, jd);
        if (!k.ok) return fail(id, k.error);
        // Freeze once for this id; retries must never replace the keyword set.
        if (fs.existsSync(kwFile)) throw new Error('keywords are already frozen');
        writeJson(kwFile, k.keywords);
      }
      const keywords = frozenKeywords(id);
      const master = readMaster(dataDir);
      if (!validateMaster(master).ok || !master.experience.length) {
        return fail(id, 'master resume is empty or invalid. Fill it in under Resume → Master first.');
      }
      meta = readMeta(id);
      const runs = (meta.runs || []).slice();
      const last = runs[runs.length - 1];
      if (!last || (mode === 'retry' && last.finished)) runs.push({ startRound: maxRound(meta) + 1, finished: false, startedAt: stamp() });
      else if (last.finished) return finish(id, master, keywords);
      patchMeta(id, { runs });
      const run = runs[runs.length - 1];
      const template = fs.readFileSync(ensureTemplate(dataDir), 'utf-8');
      const lexicon = buildLexicon(master);
      for (;;) {
        meta = readMeta(id);
        const inRun = (meta.rounds || []).filter((r) => r.n >= run.startRound);
        if (inRun.length >= MAX_ROUNDS || inRun.some((r) => r.status === 'scored' && r.score >= TARGET)) break;
        const n = run.startRound + inRun.length;
        ctx.update({ step: 'round', round: n });
        const result = await runRound({ id, n, master, keywords, jd, meta, template, lexicon });
        patchMeta(id, { rounds: [...(readMeta(id).rounds || []), result] });
      }
      meta = readMeta(id);
      patchMeta(id, { runs: meta.runs.map((r, i) => (i === meta.runs.length - 1 ? { ...r, finished: true } : r)) });
      return finish(id, master, keywords);
    } catch (err) {
      return fail(id, `unexpected error: ${err.message}`);
    }
  }

  function getRecord(id) {
    const meta = mustMeta(id);
    const dir = recDir(id);
    const rounds = (meta.rounds || []).map((r) => ({
      ...r,
      scoreDetail: readJson(path.join(dir, `round-${r.n}`, 'score.json')),
      guard: readJson(path.join(dir, `round-${r.n}`, 'guard.json')),
    }));
    return { meta, keywords: readJson(path.join(dir, 'keywords.json')), rounds, hasJd: fs.existsSync(path.join(dir, 'jd.txt')) };
  }

  function enqueueRun(id, mode) {
    patchMeta(id, { status: 'queued', error: null });
    return queue.enqueue({ kind: 'resume', key: `resume:${id}`, payload: { id, mode } }).status;
  }

  function retry(id) {
    const meta = mustMeta(id);
    if (ACTIVE.has(meta.status)) throw new ServiceError(409, 'already queued or running');
    if (!fs.existsSync(path.join(recDir(id), 'keywords.json'))) throw new ServiceError(409, 'no frozen keywords yet; paste the job description first');
    const status = enqueueRun(id, 'retry');
    return { meta: readMeta(id), queue: status };
  }

  function setJd(id, text) {
    const meta = mustMeta(id);
    if (ACTIVE.has(meta.status)) throw new ServiceError(409, 'already queued or running');
    if (fs.existsSync(path.join(recDir(id), 'keywords.json'))) {
      throw new ServiceError(409, 'keywords are frozen for this resume; delete it and tailor again to use a different job description');
    }
    const t = String(text || '').trim();
    if (t.length < MIN_PASTED_JD) throw new ServiceError(400, `paste at least ${MIN_PASTED_JD} characters of the job description`);
    fs.writeFileSync(path.join(recDir(id), 'jd.txt'), t);
    const status = enqueueRun(id, 'full');
    return { meta: readMeta(id), queue: status };
  }

  function accept(id) {
    const meta = mustMeta(id);
    if (!meta.bestRound) throw new ServiceError(409, 'nothing to accept yet: no scored round');
    if (meta.accepted) return meta;
    const updated = patchMeta(id, { accepted: true, acceptedAt: stamp() });
    const trackerFile = path.join(dataDir, 'role-tracker.json');
    const tracker = readJson(trackerFile, {});
    const actions = readJson(path.join(dataDir, 'role-actions.json'), { applied: [] });
    for (const key of meta.roleKeys) {
      const entry = tracker[key] || { stage: (actions.applied || []).includes(key) ? 'applied' : 'discovered', notes: '', checklist: [], timeline: [] };
      entry.timeline = [...(entry.timeline || []), { date: stamp(), event: `Resume tailored (${meta.bestScore})` }];
      tracker[key] = entry;
    }
    writeJson(trackerFile, tracker);
    return updated;
  }

  function remove(id) {
    const meta = mustMeta(id);
    if (meta.status === 'running') throw new ServiceError(409, 'cannot delete a running resume');
    fs.rmSync(recDir(id), { recursive: true, force: true });
  }

  function pdfPath(id, round) {
    mustMeta(id);
    let file;
    if (round === undefined || round === null || round === '') file = path.join(recDir(id), 'resume.pdf');
    else {
      const n = Number(round);
      if (!Number.isInteger(n) || n < 1) throw new ServiceError(400, 'round must be a positive integer');
      file = path.join(recDir(id), `round-${n}`, 'resume.pdf');
    }
    if (!fs.existsSync(file)) throw new ServiceError(404, 'PDF not found');
    return file;
  }

  function diff(id) {
    const meta = mustMeta(id);
    const dir = recDir(id);
    const has = (n) => fs.existsSync(path.join(dir, `round-${n}`, 'tailored.json'));
    const fallback = [...(meta.rounds || [])].reverse().find((r) => has(r.n));
    const n = meta.bestRound && has(meta.bestRound) ? meta.bestRound : fallback && fallback.n;
    if (!n) throw new ServiceError(404, 'no tailored round yet');
    return { round: n, ...diffTailored(readMaster(dataDir), readJson(path.join(dir, `round-${n}`, 'tailored.json'))) };
  }

  async function importLatex(texPath) {
    if (!fs.existsSync(texPath)) throw new ServiceError(404, `LaTeX file not found: ${path.basename(texPath)}`);
    const cwd = path.join(dataDir, 'resume', 'import');
    fs.mkdirSync(cwd, { recursive: true });
    const r = await d.runAgent({
      agent: 'latex-to-master', prompt: renderPrompt('latex-to-master', { tex: expandInputs(texPath) }),
      cwd, profile: 'read', timeoutMs: ANALYST_TIMEOUT_MS, logFile: path.join(cwd, 'agents.log'),
    });
    if (!r.ok) throw new ServiceError(502, r.timedOut ? 'the LaTeX converter timed out' : `the LaTeX converter failed: ${tail(r.stderr, 300)}`);
    const parsed = extractJson(r.stdout);
    if (!parsed.ok) throw new ServiceError(502, `the LaTeX converter: ${parsed.error}`);
    const current = readMaster(dataDir);
    const base = emptyMaster();
    const v = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
    const proposed = assignIds(current, { ...base, ...v, version: 1, contact: { ...base.contact, ...(v.contact || {}) }, meta: current.meta || base.meta });
    return { proposed, errors: validateMaster(proposed).errors, diff: lineDiff(JSON.stringify(current, null, 2), JSON.stringify(proposed, null, 2)) };
  }

  return {
    tailoredDir, listMeta, requestTailor, autoTailor, runJob, getRecord, retry, setJd, accept, remove, pdfPath, diff, importLatex,
  };
}

module.exports = { createResumeService, ServiceError, expandInputs, TARGET, MAX_ROUNDS };
