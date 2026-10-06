// app/lib/resume/master.js
const fs = require('fs');
const path = require('path');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const EDU_DATE = /^(\d{4}(-(0[1-9]|1[0-2]))?)?$/;
const ID_SUFFIX = /^(.*)\.(\d+)$/;

function emptyMaster() {
  return {
    version: 1,
    contact: { name: '', email: '', phone: '', linkedin: '', location: '', links: [] },
    headline: '',
    summary: '',
    experience: [],
    projects: [],
    skills: [],
    education: [],
    certifications: [],
    meta: { nextIds: {} },
  };
}

function formatDate(ym) {
  if (ym === null || ym === undefined || ym === '') return 'Present';
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(String(ym));
  if (!m) return String(ym);
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
}

function formatRange(start, end, sep = ' – ') {
  return `${formatDate(start)}${sep}${formatDate(end)}`;
}

function parseDisplayDate(s) {
  const t = String(s || '').trim();
  if (!t || /^(present|current)$/i.test(t)) return null;
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(t);
  if (m) {
    const i = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}`;
  }
  if (/^\d{4}$/.test(t)) return t;
  throw new Error(`unrecognized date "${s}"`);
}

function bulletGroups(m) {
  const groups = [];
  for (const e of Array.isArray(m && m.experience) ? m.experience : []) {
    if (!e || typeof e !== 'object') continue;
    for (const r of Array.isArray(e.roles) ? e.roles : []) {
      if (!r || typeof r !== 'object') continue;
      groups.push({ prefix: `exp.${r.id}`, bullets: Array.isArray(r.bullets) ? r.bullets : [] });
    }
  }
  for (const p of Array.isArray(m && m.projects) ? m.projects : []) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '');
    groups.push({ prefix: id.startsWith('proj.') ? id : `proj.${id}`, bullets: Array.isArray(p.bullets) ? p.bullets : [] });
  }
  return groups;
}

function assignIds(prev, next) {
  const out = JSON.parse(JSON.stringify(next));
  out.meta = out.meta && typeof out.meta === 'object' ? out.meta : {};
  const nextIds = {};
  const merge = (ids) => { for (const [k, v] of Object.entries(ids || {})) nextIds[k] = Math.max(nextIds[k] || 1, Number.isInteger(v) && v > 0 ? v : 1); };
  merge(prev && prev.meta && prev.meta.nextIds);
  merge(out.meta.nextIds);
  for (const m of [prev, out]) {
    for (const g of bulletGroups(m)) {
      for (const b of g.bullets) {
        const mm = b && typeof b.id === 'string' ? ID_SUFFIX.exec(b.id) : null;
        if (mm) nextIds[mm[1]] = Math.max(nextIds[mm[1]] || 1, Number(mm[2]) + 1);
      }
    }
  }
  const seen = new Set();
  for (const g of bulletGroups(out)) {
    for (const b of g.bullets) {
      if (!b || typeof b !== 'object') continue;
      if (typeof b.id === 'string' && b.id && !seen.has(b.id)) { seen.add(b.id); continue; }
      const n = nextIds[g.prefix] || 1;
      b.id = `${g.prefix}.${n}`;
      nextIds[g.prefix] = n + 1;
      seen.add(b.id);
    }
  }
  out.meta.nextIds = nextIds;
  return out;
}

function validateMaster(m) {
  const errors = [];
  const err = (p, msg) => errors.push(`${p}: ${msg}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['master: must be an object'] };
  const str = (v, p) => { if (typeof v !== 'string') err(p, 'must be a string'); };
  const list = (v, p) => { if (!Array.isArray(v)) { err(p, 'must be an array'); return []; } return v; };
  const ym = (v, p, nullable) => {
    if (nullable && v === null) return;
    if (typeof v !== 'string' || !YM.test(v)) err(p, `must be YYYY-MM${nullable ? ' or null' : ''}`);
  };
  if (m.version !== 1) err('version', 'must be 1');
  const c = m.contact && typeof m.contact === 'object' ? m.contact : (err('contact', 'must be an object'), {});
  for (const k of ['name', 'email', 'phone', 'linkedin', 'location']) str(c[k], `contact.${k}`);
  list(c.links, 'contact.links').forEach((l, i) => str(l, `contact.links[${i}]`));
  str(m.headline, 'headline');
  str(m.summary, 'summary');
  const ids = new Set();
  const variants = [];
  const bullets = (v, p) => list(v, p).forEach((b, i) => {
    const bp = `${p}[${i}]`;
    if (!b || typeof b !== 'object') return err(bp, 'must be an object');
    if (typeof b.text !== 'string' || !b.text.trim()) err(`${bp}.text`, 'must be non-empty text');
    if (b.id !== undefined) {
      if (typeof b.id !== 'string' || !b.id) err(`${bp}.id`, 'must be a non-empty string');
      else if (ids.has(b.id)) err(`${bp}.id`, `duplicate id ${b.id}`);
      else ids.add(b.id);
    }
    if (b.variantOf !== undefined) {
      if (typeof b.variantOf !== 'string') err(`${bp}.variantOf`, 'must be a string');
      else variants.push({ p: `${bp}.variantOf`, id: b.variantOf });
    }
  });
  const roleIds = new Set();
  list(m.experience, 'experience').forEach((e, i) => {
    const p = `experience[${i}]`;
    if (!e || typeof e !== 'object') return err(p, 'must be an object');
    str(e.id, `${p}.id`);
    str(e.employer, `${p}.employer`);
    ym(e.start, `${p}.start`, false);
    ym(e.end, `${p}.end`, true);
    const roles = list(e.roles, `${p}.roles`);
    if (!roles.length) err(`${p}.roles`, 'needs at least one role');
    roles.forEach((r, j) => {
      const rp = `${p}.roles[${j}]`;
      if (!r || typeof r !== 'object') return err(rp, 'must be an object');
      str(r.id, `${rp}.id`);
      str(r.title, `${rp}.title`);
      str(r.team, `${rp}.team`);
      if (roleIds.has(r.id)) err(`${rp}.id`, `duplicate role id ${r.id}`);
      roleIds.add(r.id);
      ym(r.start, `${rp}.start`, false);
      ym(r.end, `${rp}.end`, true);
      bullets(r.bullets, `${rp}.bullets`);
    });
  });
  list(m.projects, 'projects').forEach((pr, i) => {
    const p = `projects[${i}]`;
    if (!pr || typeof pr !== 'object') return err(p, 'must be an object');
    str(pr.id, `${p}.id`);
    str(pr.name, `${p}.name`);
    list(pr.tech, `${p}.tech`).forEach((t, k) => str(t, `${p}.tech[${k}]`));
    bullets(pr.bullets, `${p}.bullets`);
  });
  list(m.skills, 'skills').forEach((g, i) => {
    const p = `skills[${i}]`;
    if (!g || typeof g !== 'object') return err(p, 'must be an object');
    str(g.group, `${p}.group`);
    list(g.items, `${p}.items`).forEach((it, k) => { if (typeof it !== 'string' || !it.trim()) err(`${p}.items[${k}]`, 'must be non-empty text'); });
  });
  list(m.education, 'education').forEach((ed, i) => {
    const p = `education[${i}]`;
    if (!ed || typeof ed !== 'object') return err(p, 'must be an object');
    str(ed.school, `${p}.school`);
    str(ed.degree, `${p}.degree`);
    for (const k of ['start', 'end']) if (typeof ed[k] !== 'string' || !EDU_DATE.test(ed[k])) err(`${p}.${k}`, 'must be "", YYYY, or YYYY-MM');
  });
  list(m.certifications, 'certifications').forEach((ct, i) => {
    const p = `certifications[${i}]`;
    if (!ct || typeof ct !== 'object') return err(p, 'must be an object');
    str(ct.name, `${p}.name`);
    str(ct.date, `${p}.date`);
  });
  for (const v of variants) if (!ids.has(v.id)) err(v.p, `variantOf points at unknown bullet ${v.id}`);
  return { ok: errors.length === 0, errors };
}

function masterBulletIndex(master) {
  const idx = new Map();
  for (const e of master.experience || []) {
    for (const r of e.roles || []) {
      for (const b of r.bullets || []) {
        idx.set(b.id, { id: b.id, text: b.text, kind: 'exp', employerId: e.id, roleId: r.id, label: `${r.title} at ${e.employer}` });
      }
    }
  }
  for (const p of master.projects || []) {
    for (const b of p.bullets || []) idx.set(b.id, { id: b.id, text: b.text, kind: 'proj', projectId: p.id, label: p.name });
  }
  return idx;
}

function allMasterText(master) {
  const parts = [master.headline, master.summary];
  for (const e of master.experience || []) {
    parts.push(e.employer, formatRange(e.start, e.end));
    for (const r of e.roles || []) {
      parts.push(r.title, r.team, formatRange(r.start, r.end));
      for (const b of r.bullets || []) parts.push(b.text);
    }
  }
  for (const p of master.projects || []) {
    parts.push(p.name, (p.tech || []).join(', '));
    for (const b of p.bullets || []) parts.push(b.text);
  }
  for (const g of master.skills || []) parts.push(g.group, (g.items || []).join(', '));
  for (const ed of master.education || []) parts.push(ed.school, ed.degree, ed.end ? formatDate(ed.end) : '');
  for (const ct of master.certifications || []) parts.push(ct.name, ct.date);
  return parts.filter(Boolean).join('\n');
}

function renderMarkdown(master) {
  const m = master || emptyMaster();
  const c = m.contact || {};
  const out = [`# ${c.name || 'Resume'}`];
  const contact = [c.email, c.phone, c.linkedin, c.location, ...(c.links || [])].filter(Boolean);
  if (contact.length) out.push('', contact.join(' | '));
  if (m.headline) out.push('', `**${m.headline}**`);
  if (m.summary) out.push('', '## Summary', '', m.summary);
  if ((m.experience || []).length) {
    out.push('', '## Experience');
    for (const e of m.experience) {
      out.push('', `### ${e.employer} (${formatRange(e.start, e.end)})`);
      for (const r of e.roles || []) {
        out.push('', `**${r.title}**${r.team ? `, ${r.team}` : ''} (${formatRange(r.start, r.end)})`, '');
        for (const b of r.bullets || []) if (!b.variantOf) out.push(`- ${b.text}`);
      }
    }
  }
  if ((m.projects || []).length) {
    out.push('', '## Projects');
    for (const p of m.projects) {
      out.push('', `### ${p.name}${(p.tech || []).length ? ` (${p.tech.join(', ')})` : ''}`, '');
      for (const b of p.bullets || []) if (!b.variantOf) out.push(`- ${b.text}`);
    }
  }
  if ((m.skills || []).length) {
    out.push('', '## Skills', '');
    for (const g of m.skills) out.push(`- **${g.group}:** ${(g.items || []).join(', ')}`);
  }
  if ((m.education || []).length) {
    out.push('', '## Education', '');
    for (const ed of m.education) out.push(`- ${ed.school}, ${ed.degree}${ed.end ? ` (${formatDate(ed.end)})` : ''}`);
  }
  if ((m.certifications || []).length) {
    out.push('', '## Certifications', '');
    for (const ct of m.certifications) out.push(`- ${ct.name}${ct.date ? ` (${ct.date})` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

const masterFile = (dataDir) => path.join(dataDir, 'resume', 'master.json');

function readMaster(dataDir) {
  try { return JSON.parse(fs.readFileSync(masterFile(dataDir), 'utf-8')); } catch (err) {
    if (err.code === 'ENOENT') return emptyMaster();
    throw err;
  }
}

function normalizeMaster(next) {
  const base = emptyMaster();
  const n = next && typeof next === 'object' ? next : {};
  return { ...base, ...n, contact: { ...base.contact, ...(n.contact || {}) }, meta: { ...base.meta, ...(n.meta || {}) } };
}

function writeMaster(dataDir, next) {
  const file = masterFile(dataDir);
  const prev = fs.existsSync(file) ? readMaster(dataDir) : null;
  const out = assignIds(prev, normalizeMaster(next));
  const v = validateMaster(out);
  if (!v.ok) {
    const err = new Error(`invalid master resume: ${v.errors.slice(0, 5).join('; ')}`);
    err.validation = v.errors;
    throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return out;
}

module.exports = {
  emptyMaster, formatDate, formatRange, parseDisplayDate, validateMaster, assignIds,
  masterBulletIndex, allMasterText, renderMarkdown, readMaster, writeMaster,
};
