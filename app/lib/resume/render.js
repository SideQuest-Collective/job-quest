// app/lib/resume/render.js
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { formatDate } = require('./master');
const { REFS_DIR } = require('./lexicon');

const DEFAULT_TEMPLATE = path.join(REFS_DIR, 'template', 'resume_cv.tex');

const PUNCT = [
  [/\s*\u2014\s*/g, ' - '],
  [/[\u2013\u2015\u2212\u2010\u2011]/g, '-'],
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/\u2026/g, '...'],
  [/[\u00A0\u2007\u202F\u2009]/g, ' '],
  [/[\u2022\u00B7]/g, '-'],
  [/\u00D7/g, 'x'],
];

function toAscii(s) {
  let out = String(s ?? '');
  for (const [re, rep] of PUNCT) out = out.replace(re, rep);
  return out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\t\r]/g, ' ').replace(/[^\x20-\x7E\n]/g, '');
}

const SPECIAL = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_',
  '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  '<': '\\textless{}', '>': '\\textgreater{}',
};

function latexEscape(s) {
  return toAscii(s)
    .replace(/[\\&%$#_{}~^<>]/g, (c) => SPECIAL[c])
    .replace(/\|/g, '$|$')
    .replace(/--/g, '-{}-');
}

function urlEscape(u) {
  return toAscii(u).replace(/[\\{}]/g, '').replace(/%/g, '\\%').replace(/#/g, '\\#');
}

const REQUIRED_MACROS = ['cventry', 'cvskill', 'cventrystart', 'cventryend'];
const REQUIRED_ENVS = ['cvitems', 'cvparagraph'];

function preambleOf(templateSrc) {
  const src = String(templateSrc);
  const marker = /^[^%\n]*\\begin\{document\}/m.exec(src);
  if (!marker) throw new Error('template has no \\begin{document}');
  const i = marker.index + marker[0].length - '\\begin{document}'.length;
  const pre = src.slice(0, i)
    .replace(/\\input\{glyphtounicode\}\s*/g, '')
    .replace(/\\pdfgentounicode\s*=\s*\d+\s*/g, '')
    .replace(/\\pdf(minorversion|compresslevel|objcompresslevel)\s*=\s*\d+\s*/g, '');
  for (const m of REQUIRED_MACROS) {
    if (!new RegExp(`\\\\(?:re)?newcommand\\{?\\\\${m}(?![A-Za-z])`).test(pre)) throw new Error(`template is missing macro \\${m}`);
  }
  for (const e of REQUIRED_ENVS) {
    if (!pre.includes(`\\newenvironment{${e}}`)) throw new Error(`template is missing environment ${e}`);
  }
  return pre;
}

const byStartDesc = (a, b) => String(b.start || '').localeCompare(String(a.start || ''));

function buildDocument(master, tailored) {
  const t = tailored || {};
  const byId = (list, id) => (Array.isArray(list) ? list : []).find((x) => x && x.id === id);
  const experience = (master.experience || []).slice().sort(byStartDesc).map((me) => {
    const te = byId(t.experience, me.id) || { roles: [] };
    return {
      employer: me.employer,
      location: me.location || '',
      start: me.start,
      end: me.end,
      roles: (me.roles || []).slice().sort(byStartDesc).map((mr) => {
        const tr = byId(te.roles, mr.id) || { bullets: [] };
        return { title: mr.title, team: mr.team, start: mr.start, end: mr.end, bullets: (tr.bullets || []).map((b) => b.text) };
      }),
    };
  });
  const projects = (Array.isArray(t.projects) ? t.projects : []).map((tp) => {
    const mp = byId(master.projects, tp && tp.id);
    return mp ? { name: mp.name, tech: mp.tech || [], bullets: (tp.bullets || []).map((b) => b.text) } : null;
  }).filter(Boolean);
  return {
    contact: master.contact || {},
    headline: typeof t.headline === 'string' && t.headline.trim() ? t.headline : master.headline,
    summary: typeof t.summary === 'string' && t.summary.trim() ? t.summary : master.summary,
    experience,
    projects,
    skills: Array.isArray(t.skills) ? t.skills : [],
    education: master.education || [],
    certifications: master.certifications || [],
    additionalSections: master.additionalSections || [],
  };
}

const range = (s, e) => `${formatDate(s)} -- ${formatDate(e)}`;

function items(bullets) {
  if (!bullets || !bullets.length) return '';
  return `    \\begin{cvitems}\n${bullets.map((b) => `      \\item ${latexEscape(b)}\n`).join('')}    \\end{cvitems}\n`;
}

function link(u) {
  const display = String(u).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const target = /^https?:\/\//.test(u) ? u : `https://${display}`;
  return `\\href{${urlEscape(target)}}{${latexEscape(display)}}`;
}

function header(doc) {
  const c = doc.contact || {};
  const parts = [];
  if (c.location) parts.push(latexEscape(c.location));
  if (c.phone) parts.push(latexEscape(c.phone));
  if (c.email) parts.push(`\\href{mailto:${urlEscape(c.email)}}{${latexEscape(c.email)}}`);
  if (c.linkedin) parts.push(link(c.linkedin));
  for (const l of c.links || []) parts.push(link(l));
  const lines = ['\\begin{center}', `  {\\Huge\\bfseries ${latexEscape(c.name || '')}} \\\\[2pt]`];
  if (doc.headline) lines.push(`  \\normalsize ${latexEscape(doc.headline)} \\\\[2pt]`);
  lines.push('  \\small', `  ${parts.join(' \\hspace{1pt} $|$ \\hspace{1pt} ')}`, '\\end{center}', '');
  return lines.join('\n');
}

function summary(doc) {
  return `\\section{Summary}\n\\begin{cvparagraph}\n${latexEscape(doc.summary || '')}\n\\end{cvparagraph}\n`;
}

function experience(doc) {
  if (!doc.experience.some((e) => e.roles.length)) return '';
  let s = '\\section{Experience}\n\\cventrystart\n';
  for (const e of doc.experience) {
    s += `\n  \\vspace{0pt}\\item[]\n    \\begin{tabular*}{\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\n      \\textbf{${latexEscape(e.employer)}}${e.location ? `, ${latexEscape(e.location)}` : ''} & \\small ${range(e.start, e.end)} \\\\\n    \\end{tabular*}\\vspace{-4pt}\n`;
    for (const r of e.roles) {
      const team = r.team ? ` \\textit{\\small -- ${latexEscape(r.team)}}` : '';
      s += `\n  \\vspace{0pt}\\item[]\n    \\begin{tabular*}{\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\n      \\textbf{${latexEscape(r.title)}}${team} & \\small ${range(r.start, r.end)} \\\\\n    \\end{tabular*}\\vspace{-8pt}\n${items(r.bullets)}`;
    }
  }
  return `${s}\n\\cventryend\n`;
}

function projects(doc) {
  if (!doc.projects.length) return '';
  let s = '\\section{Projects}\n\\cventrystart\n';
  for (const p of doc.projects) {
    s += `  \\cventry\n    {${latexEscape(p.name)}}{${latexEscape((p.tech || []).join(', '))}}{}{Ongoing}\n    {${items(p.bullets).trimEnd()}}\n`;
  }
  return `${s}\\cventryend\n`;
}

function skills(doc) {
  const rows = doc.skills.filter((g) => g && (g.items || []).length)
    .map((g) => `    \\cvskill{${latexEscape(g.group)}}{${latexEscape(g.items.join(', '))}}\n`).join('');
  return `\\section{Skills}\n\\begin{itemize}[leftmargin=0.0in,label={}]\n  \\small{\\item{\n${rows}  }}\n\\end{itemize}\n`;
}

function education(doc) {
  if (!doc.education.length) return '';
  const rows = doc.education
    .map((e) => `    \\textbf{${latexEscape(e.school)}} \\hfill ${[e.start, e.end].filter(Boolean).map(formatDate).join(' -- ')} \\\\\n    ${latexEscape(e.degree)}`)
    .join(' \\\\[2pt]\n');
  return `\\section{Education}\n\\begin{itemize}[leftmargin=0.0in,label={}]\n  \\small{\\item{\n${rows}\n  }}\n\\end{itemize}\n`;
}

function certifications(doc) {
  if (!doc.certifications.length) return '';
  const rows = doc.certifications.map((c) => `  \\cventry\n    {${latexEscape(c.name)}}{}{}{${latexEscape(c.date || '')}}\n    {}\n`).join('');
  return `\\section{Certifications}\n\\cventrystart\n${rows}\\cventryend\n`;
}

function additionalSections(doc) {
  return (doc.additionalSections || []).map(section => {
    const body = String(section.body || '').split(/\n+/).map(latexEscape).join('\n\\par\n');
    return `\\section{${latexEscape(section.title)}}\n\\begin{cvparagraph}\n${body}\n\\end{cvparagraph}\n`;
  }).join('\n');
}

function renderTex(templateSrc, doc) {
  const pre = preambleOf(templateSrc);
  return [
    pre.trimEnd(), '', '\\begin{document}', '',
    header(doc), summary(doc), experience(doc), projects(doc), skills(doc), education(doc), certifications(doc), additionalSections(doc),
    '\\end{document}', '',
  ].join('\n');
}

function findTectonic() {
  const candidates = [process.env.TECTONIC_BIN, '/usr/local/bin/tectonic', '/opt/homebrew/bin/tectonic'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'tectonic'));
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function compileTex(opts = {}) {
  const texPath = path.resolve(opts.texPath);
  if (!/\.tex$/.test(texPath)) throw new Error('texPath must end in .tex');
  const { timeoutMs = 120000, bin } = opts;
  const exe = bin !== undefined ? (fs.existsSync(bin) ? bin : null) : findTectonic();
  const outDir = path.dirname(texPath);
  const pdfPath = texPath.replace(/\.tex$/, '.pdf');
  try { fs.unlinkSync(pdfPath); } catch { /* no stale PDF */ }
  if (!exe) return Promise.resolve({ ok: false, pdfPath: null, log: 'tectonic not found (brew install tectonic, or set TECTONIC_BIN)' });
  return new Promise((resolve) => {
    execFile(exe, ['--chatter', 'minimal', '--outdir', outDir, texPath], {
      cwd: outDir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin` },
    }, (err, stdout, stderr) => {
      const log = `${stdout || ''}${stderr || ''}${err ? `\n(${err.killed ? 'compile timed out' : err.message})` : ''}`;
      const ok = !err && fs.existsSync(pdfPath);
      resolve({ ok, pdfPath: ok ? pdfPath : null, log: log.slice(-3000) });
    });
  });
}

function ensureTemplate(dataDir) {
  const target = path.join(dataDir, 'resume', 'template', 'resume_cv.tex');
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let src = fs.readFileSync(DEFAULT_TEMPLATE, 'utf-8');
  const legacy = path.join(dataDir, 'resume-files', 'resume_cv.tex');
  if (fs.existsSync(legacy)) {
    const candidate = fs.readFileSync(legacy, 'utf-8');
    try { preambleOf(candidate); src = candidate; } catch { /* missing macros: keep the default */ }
  }
  fs.writeFileSync(target, src);
  return target;
}

module.exports = {
  DEFAULT_TEMPLATE, toAscii, latexEscape, urlEscape, preambleOf, buildDocument, renderTex,
  findTectonic, compileTex, ensureTemplate,
};
