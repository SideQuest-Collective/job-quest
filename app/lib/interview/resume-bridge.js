// app/lib/interview/resume-bridge.js
// The ONLY file in app/lib/interview that touches P2's resume modules.
// Tailored resumes are read by the layout fixed in the resume spec §3 ($DATA_DIR/resume/tailored/<id>/).
const fs = require('fs');
const path = require('path');
const master = require('../resume/master');
const jdfetch = require('../resume/jdfetch');

function readMasterResume(dataDir) {
  const file = path.join(dataDir, 'resume', 'master.json');
  if (!fs.existsSync(file)) return null;
  try {
    return master.readMaster(dataDir);
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${err.message}`, { cause: err });
  }
}

function renderResumeMarkdown(m) {
  return master.renderMarkdown(m);
}

async function fetchJdText(url, impl = jdfetch.fetchJd) {
  try {
    const r = await impl(url);
    if (typeof r === 'string') return r.trim() ? { ok: true, text: r } : { ok: false, error: 'empty posting' };
    if (r && r.ok !== false && typeof r.text === 'string' && r.text.trim()) return { ok: true, text: r.text };
    return { ok: false, error: (r && (r.error || r.reason)) || 'posting unavailable' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function findTailored(dataDir, roleKey) {
  const root = path.join(dataDir, 'resume', 'tailored');
  if (!fs.existsSync(root)) return null;
  let latest = null;
  let latestTime = -Infinity;
  for (const id of fs.readdirSync(root).sort()) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf-8')); } catch { continue; }
    if (!(meta.roleKeys || []).includes(roleKey)) continue;
    const updated = Date.parse(meta.updatedAt);
    const created = Date.parse(meta.createdAt);
    const time = Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : fs.statSync(path.join(root, id)).mtimeMs;
    if (time > latestTime) {
      latest = { id, meta };
      latestTime = time;
    }
  }
  if (!latest) return null;
  const jdFile = path.join(root, latest.id, 'jd.txt');
  return {
    ...latest,
    jdText: fs.existsSync(jdFile) ? fs.readFileSync(jdFile, 'utf-8') : null,
    done: ['done', 'below-target'].includes(latest.meta.status),
  };
}

module.exports = { readMasterResume, renderResumeMarkdown, fetchJdText, findTailored };
