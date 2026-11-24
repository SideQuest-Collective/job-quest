#!/usr/bin/env node
// Adapt existing evidence to native Job Quest files; never scan or generate.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const SCHEMA = 'career-review-to-native-intel/1';
const text = value => typeof value === 'string' ? value.trim() : '';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function postingUrl(value) {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase(), p = url.pathname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    let supported = false;
    if (['jobs.ashbyhq.com', 'jobs.lever.co'].includes(host)) supported = /^\/[^/]+\/[a-z0-9-]{8,}\/?$/i.test(p);
    if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(host)) supported = /^\/[^/]+\/jobs\/\d+\/?$/.test(p);
    if (host === 'ats.rippling.com') supported = /^\/[^/]+\/jobs\/[a-z0-9-]{8,}\/?$/i.test(p);
    if (host.endsWith('.myworkdayjobs.com')) supported = /\/job\/[^/]+\/.+_[a-z0-9-]+\/?$/i.test(p);
    if (host === 'jobs.smartrecruiters.com') supported = /^\/[^/]+\/\d+[^/]*\/?$/.test(p);
    if (['careers.google.com', 'www.google.com'].includes(host)) supported = /\/jobs\/results\/\d+[^/]*\/?$/.test(p);
    // A precise LinkedIn job detail route is evidence-importable; search/inbox links are not.
    if (['linkedin.com', 'www.linkedin.com'].includes(host)) supported = /^\/jobs\/view\/(?:[a-z0-9][a-z0-9-]*-)?[0-9]+\/?$/i.test(p);
    // Specific first-party career routes, never a generic careers/search page.
    if (!/(?:linkedin|indeed|glassdoor|ziprecruiter)\.com$/.test(host)) supported ||= /\/(?:careers|jobs|positions|openings)\/(?:[^/]+\/)*[a-z0-9][a-z0-9_-]{7,}\/?$/i.test(p);
    if (!supported || [...url.searchParams.keys()].some(key => /^(q|query|search)$/.test(key))) return null;
    // Retain the actual source URL; dedup comparison strips tracking separately.
    return value;
  } catch { return null; }
}
function roleIdentity(role) {
  const url = new URL(role.url); url.hash = '';
  if (['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase())) {
    const id = url.pathname.match(/([0-9]+)\/?$/)?.[1];
    if (id) { url.hostname = 'www.linkedin.com'; url.pathname = `/jobs/view/${id}/`; url.search = ''; }
  }
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|gh_src$|source$|ref$|trk$|tracking)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return `${role.company.toLowerCase()}|${role.role.toLowerCase()}|${url.href}`;
}
function projectBrief(brief) {
  if (!brief || !Array.isArray(brief.opportunities)) throw Error('Career brief must contain an opportunities array.');
  const reports = new Map(), unsupported = [], seen = new Set(); let excludedRecruiters = 0;
  brief.opportunities.map((item,index) => ({item,index})).sort((a,b) => text(b.item?.checkedAt).localeCompare(text(a.item?.checkedAt))).forEach(({item,index}) => {
    if (item?.kind !== 'job') { excludedRecruiters++; return; }
    const company = text(item.company), role = text(item.title), url = postingUrl(item.sourceUrl), checkedAt = text(item.checkedAt);
    let reason = !company || !role || company.includes('|') || role.includes('|') || /^(?:recruiter outreach|job opportunity|opportunity|hiring|recruiter)$/i.test(role) ? 'missing_precise_role_identity'
      : !url ? 'unsupported_or_generic_listing_url'
      : !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt)) ? 'missing_valid_source_check_date' : null;
    if (reason) { unsupported.push({ index, id: text(item.id) || null, reason }); return; }
    const native = { company, role, level: text(item.level) || null, location: text(item.location) || null, url,
      fit: text(item.fit) || null, checkedAt, availability: text(item.availability) || null,
      concern: text(item.concern) || null, nextAction: text(item.nextAction) || null,
      source: 'career-review-migration', sourceId: text(item.id) || null, sourceUrl: item.sourceUrl,
      sourceAccount: text(item.sourceAccount) || null, sourceLinks: Array.isArray(item.sourceLinks) ? item.sourceLinks : [], employerVerification: text(item.employerVerification) || null };
    const identity = roleIdentity(native);
    if (seen.has(identity)) { unsupported.push({ index, id: text(item.id) || null, reason: 'duplicate_listing' }); return; }
    seen.add(identity);
    const date = checkedAt.slice(0, 10);
    if (!reports.has(date)) reports.set(date, { date, roles: [], tips: [], migration: { schema: SCHEMA } });
    reports.get(date).roles.push(native);
  });
  return { reports: [...reports.values()].sort((a,b) => a.date.localeCompare(b.date)), unsupported, excludedRecruiters };
}
function migrate({ briefPath, dataDir, apply = false }) {
  const raw = fs.readFileSync(briefPath, 'utf8'), projection = projectBrief(JSON.parse(raw));
  const acceptedJobs = projection.reports.reduce((n,report) => n + report.roles.length,0);
  const intelDir = path.join(dataDir, 'intel');
  const changes = projection.reports.map(report => {
    const file = path.join(intelDir, `${report.date}-career-review-migration.json`);
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (previous !== null) {
      let existing; try { existing = JSON.parse(previous); } catch { throw Error('Existing migration destination is unreadable; no files changed.'); }
      if (existing.migration?.schema !== SCHEMA || existing.date !== report.date || !Array.isArray(existing.roles)) throw Error('Refusing to overwrite an unrelated native report.');
      // Preserve earlier migrated leads that the latest brief no longer contains.
      const current = new Set(report.roles.map(roleIdentity));
      report.roles.push(...existing.roles.filter(role => !current.has(roleIdentity(role))));
      report.tips = Array.isArray(existing.tips) ? existing.tips : [];
    }
    const next = json(report);
    return { file, previous, next, changed: next !== previous };
  });
  const changed = changes.filter(change => change.changed);
  const summary = { mode: apply ? 'apply' : 'dry-run', acceptedJobs, reportCount: changes.length, changedReports: changed.length,
    excludedRecruiters: projection.excludedRecruiters, unsupportedJobs: projection.unsupported.length,
    unsupportedRecords: projection.unsupported.map(({index,reason}) => ({index,reason})),
    unsupportedReasons: projection.unsupported.reduce((out,item) => ({ ...out, [item.reason]: (out[item.reason] || 0)+1 }), {}), backupDir: null };
  if (!apply || !changed.length) return summary;
  // All conflicts are checked before the first mutation. Back up source evidence
  // and affected destinations; unsupported records remain available for review.
  const backupDir = path.join(dataDir, 'migration-backups', `career-review-${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID()}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(backupDir,'source-brief.json'), raw, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(backupDir,'migration-report.json'), json({ schema: SCHEMA, sourceHash: hash(raw), sourcePath: path.resolve(briefPath), unsupported: projection.unsupported, summary }), { mode: 0o600, flag: 'wx' });
  for (const change of changed) if (change.previous !== null) fs.writeFileSync(path.join(backupDir,path.basename(change.file)),change.previous,{ mode: 0o600, flag: 'wx' });
  fs.mkdirSync(intelDir,{recursive:true,mode:0o700});
  for (const change of changed) {
    const current = fs.existsSync(change.file) ? fs.readFileSync(change.file,'utf8') : null;
    if (current !== change.previous) throw Error('Destination changed during migration; stop and inspect the backup before retrying.');
    const temp = `${change.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp,change.next,{mode:0o600,flag:'wx'});
      if (change.previous === null) fs.linkSync(temp,change.file); else fs.renameSync(temp,change.file);
    } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return { ...summary, backupDir };
}

function syncNativeIntel(dataDir, brief, {dryRun = false} = {}) {
  const dir=path.join(dataDir,'outreach'); fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=path.join(dir,`.intel-input-${crypto.randomUUID()}.json`);
  try { fs.writeFileSync(temp,json(brief),{mode:0o600,flag:'wx'}); return migrate({briefPath:temp,dataDir,apply:!dryRun}); }
  finally {if(fs.existsSync(temp)) fs.unlinkSync(temp);}
}
module.exports={postingUrl,projectBrief,migrate,syncNativeIntel};
