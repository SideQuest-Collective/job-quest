// app/lib/resume/import-pysource.js
// Python source adapter: all content.py literals + build.py roles + base LaTeX sections.
const { parseAssignments } = require('./pyliteral');
const { assignIds, parseDisplayDate } = require('./master');
const { slugify } = require('../jobs/slug');

function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s)) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unescapeTex = (s) => String(s).replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\\$/g, '$').replace(/\\_/g, '_');

function stripTex(s) {
  return String(s)
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
    .replace(/\\hspace\{[^}]*\}/g, ' ')
    .replace(/\$\|\$/g, '|')
    .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\\$/g, '$').replace(/\\_/g, '_')
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRange(dates) {
  const [a, b] = String(dates).split(/\s*--\s*/);
  return { start: parseDisplayDate(a), end: b === undefined ? null : parseDisplayDate(b) };
}

function parseBuildPy(src) {
  const em = /\\{1,2}textbf\{([^}]+)\} & \\{1,2}small ([A-Z][a-z]{2} \d{4}) -- (Present|[A-Z][a-z]{2} \d{4})/.exec(src);
  if (!em) throw new Error('employer line (\\textbf{<employer>} & \\small <Mon YYYY> -- <...>) not found in build.py');
  const employer = { name: unescapeTex(em[1]), start: parseDisplayDate(em[2]), end: parseDisplayDate(em[3]) };
  const roles = [];
  const re = /\brole\(\s*r?"([^"]+)"\s*,\s*r?"([^"]+)"\s*,\s*r?"([^"]+)"\s*,\s*EXP\[['"](\w+)['"]\]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const r = parseRange(m[3]);
    roles.push({ key: m[4], title: unescapeTex(m[1]), team: unescapeTex(m[2]), start: r.start, end: r.end });
  }
  if (!roles.length) throw new Error('no role("<title>", "<team>", "<dates>", EXP[...]) calls found in build.py');
  return { employer, roles };
}

function parseTexHeader(tex) {
  const center = /\\begin\{center\}([\s\S]*?)\\end\{center\}/.exec(tex);
  if (!center) throw new Error('LaTeX header (\\begin{center} ... \\end{center}) not found');
  const body = center[1];
  const nameM = /\{\\Huge((?:\\[a-zA-Z]+(?:\{[^}]*\})?)*)\s+([^}]+)\}/.exec(body);
  const headM = /\\normalsize\s+([^\n]*?)\s*\\\\/.exec(body);
  const smallIdx = body.indexOf('\\small');
  const contactSrc = smallIdx >= 0 ? body.slice(smallIdx + '\\small'.length) : '';
  const parts = contactSrc.split(/\$\|\$/).map(stripTex).filter(Boolean);
  const contact = { name: nameM ? nameM[2].trim() : '', email: '', phone: '', linkedin: '', location: '', links: [] };
  for (const p of parts) {
    if (!contact.email && /@/.test(p)) contact.email = p;
    else if (!contact.linkedin && /linkedin\.com/i.test(p)) contact.linkedin = p;
    else if (!contact.phone && /\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(p)) contact.phone = p;
    else if (/\.[a-z]{2,}\//i.test(p) || /^https?:/i.test(p)) contact.links.push(p);
    else if (!contact.location) contact.location = p;
  }
  return { contact, headline: headM ? stripTex(headM[1]) : '' };
}

function parseEducationTex(src) {
  const out = [];
  const re = /\\textbf\{([^}]+)\}\s*\\hfill\s*([^\\\n]*?)\s*\\\\\s*\n\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const end = m[2].trim();
    out.push({ school: stripTex(m[1]), degree: stripTex(m[3]), start: '', end: end ? parseDisplayDate(end) : '' });
  }
  return out;
}

function isProjectTuple(value) {
  return Array.isArray(value) && value.length === 3
    && typeof value[0] === 'string' && typeof value[1] === 'string'
    && Array.isArray(value[2]) && value[2].every((bullet) => typeof bullet === 'string');
}

function projectFrom(tuple) {
  const id = `proj.${slugify(tuple[0])}`;
  return { id, name: tuple[0], tech: splitTopLevel(tuple[1]), bullets: tuple[2].map((text, i) => ({ id: `${id}.${i + 1}`, text })) };
}

function mergeProjects(tuples) {
  const groups = new Map();
  for (const tuple of tuples) {
    const key = tuple[0].trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tuple);
  }
  return Array.from(groups.values(), (group) => {
    const project = projectFrom(group[0]);
    if (group.length === 1) return project;
    const tech = new Map();
    const bullets = new Map();
    for (const tuple of group) {
      for (const item of splitTopLevel(tuple[1])) {
        const key = item.toLowerCase();
        if (!tech.has(key)) tech.set(key, item);
      }
      for (const text of tuple[2]) {
        const key = text.replace(/\s+/g, ' ').trim();
        if (!bullets.has(key)) bullets.set(key, text);
      }
    }
    project.tech = [...tech.values()];
    project.bullets = Array.from(bullets.values(), (text, i) => ({ id: `${project.id}.${i + 1}`, text }));
    return project;
  });
}

function importPySource({ contentSrc, buildSrc, texSrc, educationSrc = '', summarySrc = null, skillsSrc = null, variant = null, onSelection = () => {} }) {
  const env = parseAssignments(contentSrc);
  for (const k of ['EXP', 'V']) if (!env[k]) throw new Error(`content.py is missing ${k}`);
  const variants = Object.keys(env.V);
  const name = variant || variants[0];
  const v = env.V[name];
  if (!v) throw new Error(`variant "${name}" not found in V (have: ${variants.join(', ')})`);
  const { employer, roles } = parseBuildPy(buildSrc);
  const { contact, headline } = parseTexHeader(texSrc);
  const missingSections = variant ? [] : [
    ...(summarySrc === null ? ['summary'] : []),
    ...(skillsSrc === null ? ['skills'] : []),
  ];
  onSelection({ name, variantCount: variants.length, missingSections });
  const master = {
    version: 1,
    contact,
    headline: variant ? v.head || '' : headline,
    summary: !variant && summarySrc !== null
      ? stripTex(/\\begin\{cvparagraph\}([\s\S]*?)\\end\{cvparagraph\}/.exec(summarySrc)?.[1] || '')
      : v.summary || '',
    experience: [{
      id: slugify(employer.name),
      employer: employer.name,
      start: employer.start,
      end: employer.end,
      roles: roles.map((r) => {
        const bullets = env.EXP[r.key];
        if (!Array.isArray(bullets)) throw new Error(`EXP["${r.key}"] referenced by build.py is missing from content.py`);
        return { id: r.key, title: r.title, team: r.team, start: r.start, end: r.end, bullets: bullets.map((text, i) => ({ id: `exp.${r.key}.${i + 1}`, text })) };
      }),
    }],
    projects: mergeProjects(Object.values(env).filter(isProjectTuple)),
    skills: !variant && skillsSrc !== null
      ? Array.from(skillsSrc.matchAll(/\\cvskill\{([^}]*)\}\s*\{([^}]*)\}/g), ([, group, items]) => ({ group: stripTex(group), items: splitTopLevel(stripTex(items)) }))
      : (v.skills || []).map(([group, items]) => ({ group, items: splitTopLevel(items) })),
    education: educationSrc ? parseEducationTex(educationSrc) : [],
    certifications: [],
    meta: { nextIds: {} },
  };
  return assignIds(null, master);
}

module.exports = { importPySource, parseTexHeader, parseBuildPy, parseEducationTex, splitTopLevel };
