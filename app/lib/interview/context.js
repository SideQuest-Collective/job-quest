// app/lib/interview/context.js
// `jq interview-context`: writes the inbound files for one role. Never blocks on workbook generation.
const fs = require('fs');
const path = require('path');
const { CONTRACT, GENERATED_BY, ROUNDS, InputError, assertRoleKey } = require('./contract');
const { slugify } = require('../jobs/slug');
const { resolveRole } = require('../jobs/roles');
const { writeOwned } = require('./markers');
const render = require('./render-context');
const resumeBridge = require('./resume-bridge');
const bridge = require('./workbook-bridge');
const { buildCheatsheet } = require('./cheatsheet');
const { buildPracticeSet } = require('./practice');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function roleIds(role) {
  return { companySlug: slugify(role.company), roleId: slugify(`${role.company} ${role.role}`) };
}

async function writeInterviewContext({ dataDir, interviewHome, roleKey, round = null, noAgent = false, fetchJd = resumeBridge.fetchJdText, runAgentFn }) {
  assertRoleKey(roleKey);
  if (round != null && round !== '' && !ROUNDS.includes(round)) throw new InputError(`round must be one of ${ROUNDS.join(', ')}`);
  const role = resolveRole(dataDir, roleKey);
  const { companySlug, roleId } = roleIds(role);
  const written = [];
  const skipped = [];
  // writeOwned creates each target directory recursively, including practice/.
  // Preserve every ownership skip verbatim, including blocked sibling details.
  const note = (r) => (r.written ? written.push(r.written) : skipped.push(r.skipped));
  const ctx = path.join(interviewHome, 'context');

  // context/resume.md
  const resumePath = path.join(ctx, 'resume.md');
  let master;
  let masterReason = 'no-master-resume';
  try { master = resumeBridge.readMasterResume(dataDir); }
  catch (error) { masterReason = `master-resume-invalid: ${error.message}`; }
  if (master) note(writeOwned(resumePath, render.renderResumeMd(master)));
  else skipped.push({ path: resumePath, reason: masterReason });

  // context/<company>-jd.md
  const jdPath = path.join(ctx, `${companySlug}-jd.md`);
  const tailored = resumeBridge.findTailored(dataDir, roleKey);
  let jdText = tailored && tailored.jdText && tailored.jdText.trim() ? tailored.jdText : null;
  let jdReason = 'no-jd';
  if (!jdText && role.url) {
    const r = await fetchJd(role.url);
    if (r.ok) jdText = r.text; else jdReason = `jd-fetch-failed: ${r.error}`;
  }
  if (jdText) note(writeOwned(jdPath, render.renderJdMd({ ...role, jdText })));
  else skipped.push({ path: jdPath, reason: jdReason });

  // context/target.md
  const tracker = readJson(path.join(dataDir, 'role-tracker.json'), {});
  const profile = readJson(path.join(dataDir, 'profile.json'), {});
  note(writeOwned(path.join(ctx, 'target.md'), render.renderTargetMd({ role, profile, trackerEntry: tracker[roleKey] || null })));

  // cheatsheets/<company>.json and practice/<roleId>.json
  const csPath = path.join(interviewHome, 'cheatsheets', `${companySlug}.json`);
  const practicePath = path.join(interviewHome, 'practice', `${roleId}.json`);
  let cheatsheet = fs.existsSync(csPath) ? csPath : null;
  let practice = null;
  const wb = bridge.findWorkbook(dataDir, roleKey);
  if (!wb) {
    skipped.push({ path: csPath, reason: 'no-workbook' });
    skipped.push({ path: practicePath, reason: 'no-workbook' });
  } else {
    const cs = await buildCheatsheet({ dataDir, roleId, company: role.company, role: role.role, workbookId: wb.id, noAgent, runAgentFn });
    if (cs.ok) {
      const doc = { _generatedBy: GENERATED_BY, contract: CONTRACT, roleKey, workbookId: wb.id, cards: cs.cards };
      const r = writeOwned(csPath, `${JSON.stringify(doc, null, 2)}\n`);
      note(r);
      cheatsheet = csPath;
      if (cs.stale) skipped.push({ path: csPath, reason: `cheatsheet-stale: ${cs.error}` });
    } else {
      skipped.push({ path: csPath, reason: cs.error });
    }
    if (!round) {
      skipped.push({ path: practicePath, reason: 'no-round' });
    } else {
      const set = buildPracticeSet({
        roleKey, workbookId: wb.id, round,
        questions: bridge.readWorkbook(dataDir, wb.id).questions,
        progress: bridge.readProgress(dataDir, wb.id),
      });
      if (!set) skipped.push({ path: practicePath, reason: `no-practice-for-${round}` });
      else if (!set.questions.length) skipped.push({ path: practicePath, reason: 'no-matching-questions' });
      else {
        const r = writeOwned(practicePath, `${JSON.stringify(set, null, 2)}\n`);
        note(r);
        practice = r.written || r.skipped.wroteInstead || null;
      }
    }
  }
  return { written, skipped, cheatsheet, practice };
}

module.exports = { roleIds, writeInterviewContext };
