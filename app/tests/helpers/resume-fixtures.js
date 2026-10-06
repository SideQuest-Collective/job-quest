// app/tests/helpers/resume-fixtures.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatDate } = require('../../lib/resume/master');

const FIX = path.join(__dirname, '..', 'fixtures', 'resume');
const fixturePath = (...p) => path.join(FIX, ...p);
const loadMaster = () => JSON.parse(fs.readFileSync(fixturePath('master.json'), 'utf-8'));
const loadKeywords = () => JSON.parse(fs.readFileSync(fixturePath('keywords.json'), 'utf-8'));
const jdText = () => fs.readFileSync(fixturePath('jd.txt'), 'utf-8');
const tmpDir = (prefix = 'jq-resume-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A tailored resume that copies every master bullet verbatim (passes the fact guard).
function identityTailored(master) {
  const keep = (bullets) => bullets.filter((b) => !b.variantOf).map((b) => ({ src: b.id, text: b.text }));
  return {
    headline: master.headline,
    summary: master.summary,
    experience: master.experience.map((e) => ({ id: e.id, roles: e.roles.map((r) => ({ id: r.id, bullets: keep(r.bullets) })) })),
    projects: master.projects.map((p) => ({ id: p.id, bullets: keep(p.bullets) })),
    skills: master.skills.map((g) => ({ group: g.group, items: g.items.slice() })),
  };
}

function analystReply() {
  return '```json\n' + JSON.stringify(loadKeywords(), null, 2) + '\n```\n';
}

// What extractPdf would return for the rendered master, one bullet per line.
function syntheticExtract(master = loadMaster(), overrides = {}) {
  const L = [];
  const add = (text, x = 20) => L.push({ text, x, y: 0, page: 1 });
  const c = master.contact;
  add(c.name);
  add(master.headline);
  add([c.location, c.phone, c.email, c.linkedin, ...(c.links || [])].join(' | '));
  add('Summary');
  add(master.summary);
  add('Experience');
  for (const e of master.experience) {
    add(`${e.employer} ${formatDate(e.start)} – ${formatDate(e.end)}`);
    for (const r of e.roles) {
      add(`${r.title} – ${r.team} ${formatDate(r.start)} – ${formatDate(r.end)}`);
      for (const b of r.bullets) add(`• ${b.text}`, 25);
    }
  }
  add('Projects');
  for (const p of master.projects) {
    add(`${p.name} Ongoing`);
    add(p.tech.join(', '));
    for (const b of p.bullets) add(`• ${b.text}`, 25);
  }
  add('Skills');
  for (const g of master.skills) add(`${g.group}: ${g.items.join(', ')}`);
  add('Education');
  for (const ed of master.education) { add(`${ed.school} ${formatDate(ed.end)}`); add(ed.degree); }
  const lines = overrides.lines ? overrides.lines(L) : L;
  return {
    lines,
    text: lines.map((l) => l.text).join('\n'),
    pages: overrides.pages ?? 1,
    fontsEmbedded: overrides.fontsEmbedded ?? true,
  };
}

module.exports = { FIX, fixturePath, loadMaster, loadKeywords, jdText, tmpDir, identityTailored, analystReply, syntheticExtract };
