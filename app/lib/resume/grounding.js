// Native master owns resume facts; legacy resume.json remains a fallback.
const fs = require('node:fs');
const path = require('node:path');
const { readMaster, renderMarkdown } = require('./master');
const text = value => typeof value === 'string' ? value.trim() : '';
function hasFacts(resume) {
  return !!(resume && (text(resume.summary) || text(resume.headline) || ['experience','projects','skills','education','additionalSections'].some(key => Array.isArray(resume[key]) && resume[key].length)));
}
function legacyMarkdown(resume) {
  const out = [`# ${text(resume.contact?.name) || 'Resume'}`];
  if (text(resume.summary)) out.push('Summary:', resume.summary);
  for (const e of Array.isArray(resume.experience) ? resume.experience : []) {
    out.push([text(e.title), text(e.company), text(e.duration)].filter(Boolean).join(' · '));
    for (const bullet of Array.isArray(e.bullets) ? e.bullets : []) if (text(bullet)) out.push(`- ${bullet}`);
  }
  const skills = (Array.isArray(resume.skills) ? resume.skills : []).filter(v => typeof v === 'string' && v.trim());
  if (skills.length) out.push('Skills:', skills.join(', '));
  return out.filter(Boolean).join('\n');
}
function behavioralResumeContext(dataDir, requestFallback = null) {
  const master = readMaster(dataDir); // unreadable saved data fails visibly, never silently replaced
  if (hasFacts(master)) return { source: 'master', resume: master, content: renderMarkdown(master) };
  let legacy = null;
  try { legacy = JSON.parse(fs.readFileSync(path.join(dataDir,'resume.json'),'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hasFacts(legacy)) return { source: 'legacy', resume: legacy, content: legacyMarkdown(legacy) };
  if (hasFacts(requestFallback)) {
    const nested = (requestFallback.experience || []).some(e => Array.isArray(e.roles));
    return { source: 'request', resume: requestFallback, content: nested ? renderMarkdown(requestFallback) : legacyMarkdown(requestFallback) };
  }
  return { source: 'unavailable', resume: null, content: 'No detailed resume available.' };
}
module.exports = { behavioralResumeContext, hasFacts, legacyMarkdown };
