// app/lib/workbook/steps-prepare.js
const fs = require('fs');
const path = require('path');
const store = require('./store');
const prompts = require('./prompts');
const { resolveRole } = require('../jobs/roles');
const { extractUrls } = require('./linkcheck');
const { validateOutline, assignIds, extractJsonObject } = require('./outline');
const { parseContentDir } = require('./parse');

function readText(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

function escapeResearch(text) {
  return String(text).replace(/<\/research>/gi, '&lt;/research&gt;');
}

function collectTips(dataDir, company) {
  const dir = path.join(dataDir, 'intel');
  if (!fs.existsSync(dir)) return [];
  const want = String(company || '').toLowerCase();
  const out = [];
  const seen = new Set();
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, 30);
  for (const f of files) {
    const day = store.readJsonFile(path.join(dir, f), {});
    for (const t of (day && day.tips) || []) {
      const tc = String((t && t.company) || '').toLowerCase();
      if (!tc || !want || !(want.includes(tc) || tc.includes(want))) continue;
      if (!t.text || seen.has(t.text)) continue;
      seen.add(t.text);
      out.push({ text: t.text, source: t.source || null });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

function researchAccepted(text, deep) {
  if (deep) {
    const i = text.indexOf('## Onsite research');
    return i >= 0 && /https?:\/\/\S+/.test(text.slice(i));
  }
  const m = text.match(/^## Sources[ \t]*$/m);
  if (!m) return false;
  const after = text.slice(m.index + m[0].length);
  const next = after.search(/^## /m);
  return /https?:\/\/\S+/.test(next >= 0 ? after.slice(0, next) : after);
}

function fallbackResearch(role, tips) {
  const lines = [
    '## Role summary', '',
    `- Company: ${role.company}`, `- Role: ${role.role}`, `- Level: ${role.level || 'not listed'}`, `- Location: ${role.location || 'not listed'}`, '',
    '## Why this role fits', '', role.fit || 'No fit analysis available.', '',
    '## Interview tips', '',
  ];
  if (tips.length) for (const t of tips) lines.push(`- ${t.text} (source: ${t.source || 'unknown'})`);
  else lines.push('- None collected yet.');
  lines.push('', '## Confidence notes', '', 'Web research was unavailable, so this file holds only what Job Quest already knew about the role.', '', '## Sources', '');
  lines.push(role.url ? `- [Job posting](${role.url})` : '- None.');
  return `${lines.join('\n')}\n`;
}

async function research(env) {
  const deep = env.mode === 'expand';
  const meta = env.getMeta();
  const file = path.join(env.dir, 'research.md');
  if (!deep && researchAccepted(readText(file), false)) return;
  const role = resolveRole(env.dataDir, meta.roleKeys[0]);
  const tips = collectTips(env.dataDir, role.company);
  const previous = readText(file);
  const suppliedResearch = escapeResearch(previous);
  const scratch = path.join(env.dir, 'research');
  fs.mkdirSync(scratch, { recursive: true });
  const candidate = path.join(scratch, 'research.md');
  const prompt = prompts.researcherPrompt({ meta, role, tips, profile: env.profile, mode: deep ? 'deep' : 'screen', research: suppliedResearch });
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.rmSync(candidate, { force: true });
    await env.runAgent({ agent: 'researcher', prompt, cwd: scratch, profile: 'research', timeoutMs: env.timeouts.researcher, logFile: env.logFile('researcher') });
    const text = readText(candidate);
    // Screening content is server-owned; only accept an additive deep result.
    if (researchAccepted(text, deep) && (!deep || text.startsWith(suppliedResearch))) {
      fs.copyFileSync(candidate, file);
      if (!deep) env.setMeta({ researched: true });
      return;
    }
  }
  env.state.steps.research.fallback = true;
  if (deep) {
    fs.appendFileSync(file, '\n## Onsite research\n\nWeb research was unavailable for the onsite expansion. Chapters are planned from the role posting, the fit analysis, and the screening research above.\n');
  } else {
    fs.writeFileSync(file, fallbackResearch(role, tips));
    env.setMeta({ researched: false });
  }
}

async function links(env) {
  const meta = env.getMeta();
  const role = resolveRole(env.dataDir, meta.roleKeys[0]);
  const urls = extractUrls(readText(path.join(env.dir, 'research.md')));
  if (role.url && !urls.includes(role.url)) urls.unshift(role.url);
  const result = await env.linkCheck({ urls, roleUrl: role.url || null });
  store.writeJsonAtomic(path.join(env.dir, 'links.json'), { checkedAt: env.now().toISOString(), roleUrl: role.url || null, ...result });
  env.setMeta({ postingLive: result.postingLive });
}

function existingOutline(env) {
  const saved = store.readJsonFile(path.join(env.dir, 'outline.json'), null);
  const chapters = saved && Array.isArray(saved.chapters)
    ? saved.chapters.filter((c) => c.addedBy !== env.state.runId) : [];
  const currentIds = new Set((saved && saved.chapters || []).filter((c) => c.addedBy === env.state.runId).map((c) => c.id));
  const parsed = parseContentDir(path.join(env.dir, 'content'));
  const firstLine = (body) => String(body || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '';
  for (const c of parsed.chapters) {
    if (currentIds.has(c.id)) continue;
    const questions = parsed.questions.filter((q) => q.chapter === c.id).map((q) => ({ id: q.id, title: firstLine(q.body) }));
    const existing = chapters.find((chapter) => chapter.id === c.id);
    if (existing) {
      // Interview content can change after outline.json was last saved.
      if (c.id === store.ASKED.id) existing.questions = questions;
    } else {
      chapters.push({
        id: c.id, file: c.file, title: c.title || c.id, topic: c.topic || '', company: c.company || 'both',
        kind: 'concepts', summary: '', questions,
      });
    }
  }
  return { chapters };
}

async function plan(env) {
  const expand = env.mode === 'expand';
  const meta = env.getMeta();
  const tier = expand ? 'onsite' : 'screen';
  // Existing chapters: the outline on expansion, or chapters already in content/ (an imported kit, or the
  // interview chapter 99-asked-in-interviews.md of an interview-only workbook being generated into).
  const found = existingOutline(env);
  const existing = found.chapters.length ? found : null;
  const contentIds = parseContentDir(path.join(env.dir, 'content')).chapters.map((c) => c.id);
  const existingIds = [...new Set([...(existing ? existing.chapters.map((c) => c.id) : []), ...contentIds])];
  const startIndex = existing ? existing.chapters.filter((c) => c.id !== store.ASKED.id && c.file !== store.ASKED.file).length : 0;
  const researchText = escapeResearch(readText(path.join(env.dir, 'research.md')));
  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = prompts.plannerPrompt({ meta, research: researchText, profile: env.profile, tier, existingOutline: existing, errors });
    const r = await env.runAgent({ agent: 'planner', prompt, cwd: env.dir, profile: 'read', timeoutMs: env.timeouts.planner, logFile: env.logFile('planner') });
    const outline = extractJsonObject(r.stdout || '');
    errors = outline ? validateOutline(outline, { tier, existingIds }) : ['the reply was not a single JSON object'];
    if (!r.ok) errors = [r.timedOut ? 'the planner timed out' : `the planner exited with code ${r.code}`, ...errors];
    if (!errors.length && startIndex + outline.chapters.length >= 99) {
      throw new Error('plan rejected: chapter numbering would reach 99, which is reserved for the interview chapter');
    }
    if (!errors.length) {
      const assigned = assignIds(outline, { startIndex, runId: env.state.runId });
      if (assigned.chapters.some((c) => Number(c.nn) > 98)) throw new Error('generated chapter number must be at most 98');
      store.writeJsonAtomic(path.join(env.dir, 'outline.json'), { chapters: [...(existing ? existing.chapters : []), ...assigned.chapters] });
      for (const c of assigned.chapters) {
        env.state.chapters[c.id] = {
          id: c.id, nn: c.nn, file: c.file, glossaryFile: c.glossaryFile, title: c.title, status: 'pending',
          attempts: 0, fixRounds: 0, lint: [], verify: [], review: null, error: null, run: env.state.runId,
        };
      }
      env.save();
      return;
    }
  }
  throw new Error(`plan rejected: ${errors.join('; ')}`);
}

module.exports = { research, links, plan, collectTips, researchAccepted, fallbackResearch, escapeResearch };
