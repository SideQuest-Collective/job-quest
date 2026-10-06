// app/tests/helpers/workbook-fakes.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../../lib/workbook/store');
const { screenOutline, onsiteOutline } = require('./workbook-outlines');

const FAKE_AGENT = path.join(__dirname, '..', 'fixtures', 'fake-agent.js');

// Each function below is serialized with toString() into <cwd>/.fake/<agent>.js,
// so it may only use its arguments and require().
async function researcher({ prompt, cwd, fs, path }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.fake', 'config.json'), 'utf-8'));
  const file = path.join(cwd, 'research.md');
  if (/^MODE: deep$/m.test(prompt)) {
    if (cfg.deepResearchFails) return;
    fs.writeFileSync(file, prompt.split('<research>\n')[1].split('\n</research>')[0] + '\n## Onsite research\n\nFive rounds.\n\n### Sources\n- [Onsite report](https://example.com/onsite)\n');
    return;
  }
  if (cfg.researchFails) { fs.writeFileSync(file, '## Role summary\n\nNothing found.\n'); return; }
  fs.writeFileSync(file, '## Role summary\n\nAcme builds widgets.\n\n## Sources\n- [Acme careers](https://example.com/job)\n');
}

async function planner({ prompt, cwd, fs, path, attempt }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.fake', 'config.json'), 'utf-8'));
  fs.writeFileSync(path.join(cwd, '.fake', `planner-prompt-${attempt}.md`), prompt);
  if (cfg.plannerBad === 'always' || (cfg.plannerBad === 'first' && attempt === 0)) {
    process.stdout.write('I think you should study arrays.');
    return;
  }
  const onsite = /^TIER: onsite$/m.test(prompt);
  process.stdout.write(JSON.stringify(onsite ? cfg.onsiteOutline : cfg.screenOutline));
}

async function writer({ prompt, cwd, fs, path }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.fake', 'config.json'), 'utf-8'));
  const get = (k) => (prompt.match(new RegExp(`^${k}: (.+)$`, 'm')) || [])[1];
  const target = get('TARGET_FILE');
  const gloss = get('GLOSSARY_FILE');
  const id = get('CHAPTER_ID');
  const mode = get('MODE');
  const events = path.join(cwd, '.fake', 'writer-events.log');
  fs.appendFileSync(events, `start ${id} ${mode}\n`);
  if (cfg.writerDelayMs) await new Promise((r) => setTimeout(r, cfg.writerDelayMs));
  const headers = prompt.split('HEADERS-BEGIN\n')[1].split('\nHEADERS-END')[0].split('\n');
  const broken = (cfg.brokenAlways || []).includes(id) || ((cfg.brokenFirst || []).includes(id) && mode === 'write');
  const wrong = (cfg.wrongCode || {})[id];
  const plus = wrong === 'always' || (wrong === 'once' && mode !== 'fix-verify') ? 2 : 1;
  const out = [];
  for (const h of headers) {
    if (h.startsWith('@@chapter')) {
      out.push(h, '## In plain English', '', 'Plain words.', '');
      if (!broken) out.push('## Key takeaways', '', '- One idea.', '');
      continue;
    }
    const qid = h.match(/ id=(\S+)/)[1];
    const type = h.match(/ type=(\S+)/)[1];
    out.push(h, `Question ${qid}?`, '');
    if (type === 'mcq') out.push('@@choices', '- [x] alpha one', '- [ ] bravo two', '- [ ] charlie three', '');
    else out.push('@@rubric', '- Names the idea.', '');
    if (type === 'code') {
      const fn = `f_${qid.replace(/[^a-z0-9]/g, '_')}`;
      out.push('@@tests', '```json', JSON.stringify({ entry: fn, cases: [{ args: [1], expect: 2 }] }), '```', '',
        '@@answer', 'Add one.', '', '```python', `def ${fn}(x):`, `    return x + ${plus}`, '```', '');
    } else {
      out.push('@@answer', 'Because.', '');
    }
  }
  fs.mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
  fs.writeFileSync(path.join(cwd, target), out.join('\n'));
  fs.writeFileSync(path.join(cwd, gloss), 'widget :: A small thing.\n');
  fs.appendFileSync(events, `end ${id} ${mode}\n`);
}

async function editor({ prompt, cwd, fs, path }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.fake', 'config.json'), 'utf-8'));
  const get = (k) => (prompt.match(new RegExp(`^${k}: (.+)$`, 'm')) || [])[1];
  const target = path.join(cwd, get('TARGET_FILE'));
  const id = get('CHAPTER_ID');
  let text = fs.readFileSync(target, 'utf-8').replace('Plain words.', 'Plain, clear words.');
  if ((cfg.editorBreaks || []).includes(id)) text = text.replace('## Key takeaways\n', '');
  if ((cfg.editorBreaksCode || []).includes(id)) text = text.replace(/return x \+ 1/g, 'return x + 5');
  fs.writeFileSync(target, text);
  fs.writeFileSync(path.join(cwd, get('REVIEW_FILE')), JSON.stringify({ chapterId: id, verdict: 'edited', edits: ['clarified the opener'], concerns: [] }));
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.fake', 'config.json'), 'utf-8'));
}

function writeScripts(dir, config) {
  const fakeDir = path.join(dir, '.fake');
  const script = (fn) => `module.exports = ${fn.toString()};\n`;
  fs.writeFileSync(path.join(fakeDir, 'researcher.js'), script(researcher));
  fs.writeFileSync(path.join(fakeDir, 'planner.js'), script(planner));
  const ids = [...config.screenOutline.chapters, ...config.onsiteOutline.chapters].map((c) => c.id);
  for (const id of ids) {
    fs.writeFileSync(path.join(fakeDir, `writer-${id}.js`), script(writer));
    fs.writeFileSync(path.join(fakeDir, `editor-${id}.js`), script(editor));
  }
}

function installFakes(dir, config = {}) {
  fs.mkdirSync(path.join(dir, '.fake'), { recursive: true });
  for (const name of ['drafts', 'research']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.symlinkSync(path.join(dir, '.fake'), path.join(dir, name, '.fake'));
  }
  const full = { screenOutline: screenOutline(), onsiteOutline: onsiteOutline(), ...config };
  fs.writeFileSync(path.join(dir, '.fake', 'config.json'), JSON.stringify(full));
  writeScripts(dir, full);
}

function setConfig(dir, patch) {
  const next = { ...readConfig(dir), ...patch };
  fs.writeFileSync(path.join(dir, '.fake', 'config.json'), JSON.stringify(next));
  writeScripts(dir, next);
}

function useFakeRuntime(t) {
  const prev = process.env.JOB_QUEST_FAKE_AGENT;
  process.env.JOB_QUEST_FAKE_AGENT = FAKE_AGENT;
  t.after(() => {
    if (prev === undefined) delete process.env.JOB_QUEST_FAKE_AGENT;
    else process.env.JOB_QUEST_FAKE_AGENT = prev;
  });
}

function setup(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-orch-'));
  fs.writeFileSync(path.join(dataDir, 'profile.json'), JSON.stringify({
    name: 'Sam', currentRole: 'Senior Engineer', yearsExperience: 7, strengths: ['React'], interviewWeakSpots: ['system design'], targetLevel: 'Staff',
  }));
  const meta = store.createWorkbook(dataDir, { roleKeys: ['Acme|Staff Engineer'] });
  const dir = store.wbDir(dataDir, meta.id);
  installFakes(dir, config);
  return { dataDir, meta, dir };
}

async function noLinks({ urls, roleUrl }) {
  return { results: urls.map((url) => ({ url, status: 200, finalUrl: url, dead: false, reason: null })), postingLive: roleUrl ? true : null };
}

function agentCalls(dir) {
  const raw = require('../fixtures/fake-calls').readFakeCalls(dir);
  const out = {};
  for (const [name, n] of Object.entries(raw)) {
    const family = name.split('-')[0];
    out[family] = (out[family] || 0) + n;
  }
  return out;
}

function contentHashes(dir) {
  const c = path.join(dir, 'content');
  if (!fs.existsSync(c)) return {};
  const out = {};
  for (const n of fs.readdirSync(c).sort()) out[n] = crypto.createHash('sha256').update(fs.readFileSync(path.join(c, n))).digest('hex');
  return out;
}

function maxConcurrency(dir) {
  const file = path.join(dir, '.fake', 'writer-events.log');
  let cur = 0;
  let max = 0;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (line.startsWith('start ')) { cur += 1; max = Math.max(max, cur); }
    if (line.startsWith('end ')) cur -= 1;
  }
  return max;
}

function job(id, workbookId, mode = 'create') {
  return { id, payload: { workbookId, mode } };
}

module.exports = { FAKE_AGENT, useFakeRuntime, setup, installFakes, setConfig, noLinks, agentCalls, contentHashes, maxConcurrency, job };
