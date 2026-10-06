// app/lib/interview/render-context.js
// Deterministic renderers for ~/.interview/context/*.md (contract: inbound files).
const { MARKER_MD } = require('./contract');
const resumeBridge = require('./resume-bridge');

function withMarker(md) {
  return `${MARKER_MD}\n${String(md).replace(/^\s+/, '').replace(/\s+$/, '')}\n`;
}

function renderResumeMd(master) {
  return withMarker(resumeBridge.renderResumeMarkdown(master));
}

function renderJdMd({ company, role, level, location, url, jdText }) {
  return withMarker([
    `# ${company}: ${role} (job description)`,
    '',
    `Level: ${level || 'not stated'}. Location: ${location || 'not stated'}.`,
    url ? `Posting: ${url}` : 'Posting: none on file',
    '',
    String(jdText || '').trim(),
  ].join('\n'));
}

function formatComp(comp) {
  if (comp == null) return null;
  if (typeof comp === 'string') return comp.trim() || null;
  if (typeof comp === 'number') return String(comp);
  if (typeof comp === 'object') {
    const parts = Object.entries(comp).map(([k, v]) => [k, formatComp(v)])
      .filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`);
    return parts.length ? parts.join('; ') : null;
  }
  return String(comp);
}

function renderTargetMd({ role, profile = {}, trackerEntry = null }) {
  const level = role.level || profile.targetLevel || null;
  const lines = [
    `# Target: ${role.company} — ${role.role}`,
    '',
    '## Role',
    `- Title and level I am targeting: ${role.role}${level ? ` (${level})` : ''}`,
  ];
  if (role.location) lines.push(`- Location of the role: ${role.location}`);
  if (role.url) lines.push(`- Posting: ${role.url}`);
  if (trackerEntry && trackerEntry.stage) lines.push(`- Where I am in the process: ${trackerEntry.stage}`);
  lines.push('', '## My answers, decided in advance');
  lines.push(`- Compensation expectation: ${formatComp(profile.comp) || 'decide a number before the call'}`);
  if (profile.locationPrefs) lines.push(`- Location and remote preference: ${profile.locationPrefs}`);
  if (profile.timeline) lines.push(`- Timeline: ${profile.timeline}`);
  if (Array.isArray(profile.values) && profile.values.length) lines.push(`- What I care about in the next role: ${profile.values.join(', ')}`);
  const notes = trackerEntry ? String(trackerEntry.notes || '').trim() : '';
  if (notes) lines.push('', '## Notes from Job Quest (includes memory from earlier recruiter calls)', '', notes);
  return withMarker(lines.join('\n'));
}

module.exports = { withMarker, renderResumeMd, renderJdMd, renderTargetMd, formatComp };
