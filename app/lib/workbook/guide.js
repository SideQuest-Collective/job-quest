// app/lib/workbook/guide.js
// The printable study guide behind "Download offline": the few predicted questions from the research,
// explained in plain English with one or two related questions each, capped at MAX_PAGES pages.
// Written by one agent on demand, checked here, printed to PDF, and cached until the workbook changes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./store');
const { REF_DIR, renderTemplate, profileSummary } = require('./prompts');
const { parseDiagram } = require('./diagram');
const { markdown } = require('./print');
const { htmlToPdf } = require('./pdf');
const { splitRoleKey } = require('../jobs/roles');

const MAX_PAGES = 15;
const MAX_WORDS = 5500;
const GUIDE_TIMEOUT_MS = 15 * 60000;
const GUIDE_FILE = 'guide.md';
const GUIDE_PDF = 'guide.pdf';
const GUIDE_STATE = 'guide.json';
const MAX_SOURCE_CHARS = 60000;

const read = (file) => { try { return fs.readFileSync(file, 'utf-8'); } catch { return null; } };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; } };

function guideJobKey(id) { return `workbook-guide:${id}`; }

function readGuideState(dataDir, id) { return readJson(path.join(store.wbDir(dataDir, id), GUIDE_STATE), null); }

function writeGuideState(dataDir, id, state) { store.writeJsonAtomic(path.join(store.wbDir(dataDir, id), GUIDE_STATE), state); }

function trackerNotes(dataDir, roleKeys) {
  const tracker = readJson(path.join(dataDir, 'role-tracker.json'), {});
  return (roleKeys || []).map((k) => (tracker[k] && tracker[k].notes ? `### ${k}\n${tracker[k].notes}` : '')).filter(Boolean).join('\n\n');
}

// Everything the guide is written from. The hash decides whether a cached guide is still current.
function guideInputs(dataDir, id) {
  const meta = store.readMeta(dataDir, id);
  const dir = store.wbDir(dataDir, id);
  const parsed = store.loadParsed(dataDir, id);
  const research = read(path.join(dir, 'research.md'));
  const notes = trackerNotes(dataDir, meta.roleKeys);
  const companies = new Set(Object.keys(meta.companyNames || {}));
  const asked = parsed.questions.filter((q) => q.chapter === store.ASKED.id);
  let source = research || '';
  if (notes) source += `${source ? '\n\n' : ''}## Notes from the role tracker\n\n${notes}`;
  if (!research) {
    // Imported kits have no research.md: their company-specific chapters carry the research.
    const own = parsed.chapters.filter((c) => companies.has(c.company) && c.id !== store.ASKED.id);
    source += `\n\n## Company-specific workbook chapters\n\n${own.map((c) => `### ${c.title}\n${c.body}`).join('\n\n')}`;
  }
  if (source.length > MAX_SOURCE_CHARS) source = `${source.slice(0, MAX_SOURCE_CHARS)}\n\n(truncated)`;
  const outline = parsed.chapters.filter((c) => c.id !== store.ASKED.id).map((c) => `- ${c.title}`).join('\n') || '- (none)';
  const askedText = asked.length ? asked.map((q) => `- ${q.body.split('\n').find((l) => l.trim()) || q.id}`).join('\n') : '- (none yet)';
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify([source, outline, askedText, read(path.join(REF_DIR, 'agents', 'guide-writer.md'))]))
    .digest('hex').slice(0, 16);
  return { meta, source, outline, asked: askedText, hash };
}

function diagramSpec() {
  const spec = read(path.join(REF_DIR, 'format-spec.md')) || '';
  const m = spec.match(/## Diagrams[\s\S]*?(?=\n## Glossary file)/);
  return m ? m[0].trim() : '';
}

function guidePrompt({ meta, profile, inputs, mode = 'write', problems = [] }) {
  const { company } = splitRoleKey((meta.roleKeys || [])[0] || `${meta.company || 'The company'}|${meta.role || 'the role'}`);
  const role = (meta.roleKeys || []).map((k) => splitRoleKey(k).role).join(' / ') || meta.role || 'the role';
  const fixSection = problems.length
    ? `## Fix these problems in your previous draft\n\nYour last draft of \`${GUIDE_FILE}\` is in the current directory. Rewrite it so these are fixed, keeping everything else:\n\n${problems.map((p) => `- ${p}`).join('\n')}`
    : '';
  return renderTemplate(read(path.join(REF_DIR, 'agents', 'guide-writer.md')), {
    targetFile: GUIDE_FILE, mode, company: meta.company || company, role,
    maxPages: MAX_PAGES, maxWords: MAX_WORDS, profileSummary: profileSummary(profile),
    research: inputs.source, outline: inputs.outline, asked: inputs.asked, diagramSpec: diagramSpec(), fixSection,
  });
}

function pythonBlocks(text) {
  const out = [];
  const re = /```python[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function defaultPythonCheck(code) {
  const r = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf-8', timeout: 10000 });
  if (r.error) return null; // no Python here: skip the syntax check rather than fail the guide
  return r.status === 0 ? null : (r.stderr || '').trim().split('\n').pop();
}

// Problems a reader would hit; each is phrased as an instruction the writer can act on.
function checkGuide(text, { pythonCheck = defaultPythonCheck } = {}) {
  const problems = [];
  const t = String(text || '');
  if (!/^#\s+\S/m.test(t)) problems.push('Start the guide with a `#` title line.');
  if (!/^###\s+Predicted:/m.test(t)) problems.push('Give each predicted question its own `### Predicted: ...` heading.');
  if (/^@@/m.test(t)) problems.push('Remove every line that starts with `@@`; the guide is plain Markdown.');
  if (/^\s*-\s*\[( |x)\]/im.test(t)) problems.push('Remove the multiple-choice options (`- [ ]` lines); the guide has no multiple-choice questions.');
  if (/<\/script/i.test(t)) problems.push('Remove the text `</script`.');
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) problems.push(`The guide is ${words} words; cut it to at most ${MAX_WORDS} by dropping the least likely material, not by turning sentences into notes.`);
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```diagram\s*$/.test(lines[i])) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++]);
    for (const e of parseDiagram(body.join('\n')).errors) problems.push(`Diagram starting on line ${i + 1}: ${e}`);
    i = j;
  }
  pythonBlocks(t).forEach((code, n) => {
    const err = pythonCheck(code);
    if (err) problems.push(`Python block ${n + 1} does not parse: ${err}`);
  });
  return problems;
}

function countPdfPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}

const GUIDE_CSS = `
@page { size: Letter; margin: 0.6in 0.7in; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.45; color: #1b1b1b; }
h1, h2, h3, h4 { font-family: Helvetica, Arial, sans-serif; color: #1F4E79; page-break-after: avoid; }
h1 { font-size: 21pt; margin: 0 0 6pt; border-bottom: 2.5px solid #1F4E79; padding-bottom: 4pt; }
h2 { font-size: 16pt; margin: 20pt 0 6pt; border-bottom: 1.5px solid #1F4E79; padding-bottom: 2pt; }
h3 { font-size: 13pt; margin: 14pt 0 4pt; }
h4 { font-size: 11.5pt; margin: 10pt 0 3pt; color: #333; }
pre { background: #EEF3F9; padding: 6pt 8pt; border-radius: 4px; font-size: 8.6pt; line-height: 1.35; white-space: pre-wrap; page-break-inside: avoid; }
code { font-family: Menlo, Consolas, monospace; font-size: 0.86em; background: #EEF3F9; padding: 0 2px; border-radius: 2px; }
pre code { background: none; padding: 0; font-size: inherit; }
table { border-collapse: collapse; margin: 6pt 0; font-size: 9.8pt; width: 100%; page-break-inside: avoid; }
th, td { border: 1px solid #c8d3e0; padding: 3pt 6pt; text-align: left; vertical-align: top; }
th { background: #EEF3F9; font-family: Helvetica, Arial, sans-serif; }
blockquote { border-left: 4px solid #1F4E79; margin: 8pt 0; padding: 2pt 12pt; background: #FFF6D6; }
figure.diagram { margin: 8pt 0 12pt; page-break-inside: avoid; }
figure.diagram svg { width: 100%; height: auto; max-height: 4.2in; }
figcaption { text-align: center; font-size: 9pt; color: #555; font-style: italic; }
.diagram-legend { font-size: 8.5pt; margin: 0 0 4pt; font-family: Helvetica, Arial, sans-serif; }
`;

function guideHtml(meta, text) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${String(meta.title || 'Study guide').replace(/</g, '')}</title><style>${GUIDE_CSS}</style></head><body>${markdown(text, 0)}</body></html>`;
}

// A retry after a failure: clear the failed state so the status page shows progress again.
function markQueued(dataDir, id, hash) {
  writeGuideState(dataDir, id, { ...(readGuideState(dataDir, id) || {}), status: 'queued', hash, error: null });
}

function createGuideHandler(deps = {}) {
  const { dataDir } = deps;
  const now = deps.now || (() => new Date());
  const runAgent = deps.runAgent || require('../jobs/runner').runAgent;
  const toPdf = deps.htmlToPdf || htmlToPdf;
  const readProfile = deps.readProfile || ((d) => readJson(path.join(d, 'profile.json'), {}));
  const pythonCheck = deps.pythonCheck || defaultPythonCheck;
  const timeoutMs = deps.timeoutMs || GUIDE_TIMEOUT_MS;

  return async function handleGuideJob(job, ctx = { update() {} }) {
    const id = job && job.payload && job.payload.workbookId;
    if (!store.isValidId(id) || !store.readMeta(dataDir, id)) throw new Error(`workbook ${id} not found`);
    const dir = store.wbDir(dataDir, id);
    const scratch = path.join(dir, 'drafts'); // run-agent.sh fences writes to this folder
    fs.mkdirSync(scratch, { recursive: true });
    const draft = path.join(scratch, GUIDE_FILE);
    const inputs = guideInputs(dataDir, id);
    const prior = readGuideState(dataDir, id);
    writeGuideState(dataDir, id, { ...(prior || {}), status: 'writing', hash: inputs.hash, startedAt: now().toISOString(), error: null });
    const fail = (message) => {
      writeGuideState(dataDir, id, { ...(readGuideState(dataDir, id) || {}), status: 'failed', error: message, finishedAt: now().toISOString() });
      throw new Error(message);
    };
    let problems = [];
    let pdf = null;
    let pages = 0;
    fs.rmSync(draft, { force: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (ctx && ctx.update) ctx.update({ workbookId: id, step: attempt ? 'guide-fix' : 'guide', attempt });
      const prompt = guidePrompt({ meta: inputs.meta, profile: readProfile(dataDir), inputs, mode: attempt ? 'fix' : 'write', problems });
      const res = await runAgent({ agent: `guide-${attempt ? 'fix' : 'write'}`, prompt, cwd: scratch, profile: 'write', timeoutMs, logFile: path.join(dir, 'logs', 'guide.log') });
      const text = read(draft);
      if (text === null) {
        problems = [`${GUIDE_FILE} was not written${res && !res.ok ? ` (the agent stopped: ${String(res.stderr || res.code || '').trim().split('\n').pop()})` : ''}`];
        continue;
      }
      problems = checkGuide(text, { pythonCheck });
      if (problems.length) continue;
      pdf = await toPdf(guideHtml(inputs.meta, text));
      pages = countPdfPages(pdf);
      if (pages > MAX_PAGES) { problems = [`The guide prints as ${pages} pages; cut it to at most ${MAX_PAGES} by dropping the least likely questions and side material.`]; pdf = null; continue; }
      fs.writeFileSync(path.join(dir, GUIDE_FILE), text);
      fs.writeFileSync(path.join(dir, GUIDE_PDF), pdf);
      fs.rmSync(draft, { force: true });
      const state = { status: 'ready', hash: inputs.hash, pages, builtAt: now().toISOString(), error: null };
      writeGuideState(dataDir, id, state);
      return { workbookId: id, ...state };
    }
    return fail(problems.join(' '));
  };
}

module.exports = {
  MAX_PAGES, MAX_WORDS, GUIDE_PDF, guideJobKey, markQueued, readGuideState, guideInputs, guidePrompt, checkGuide, countPdfPages, guideHtml, createGuideHandler,
};
