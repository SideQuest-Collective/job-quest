const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {syncNativeIntel}=require('../lib/outreach/intel');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jq-outreach-intel-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'intel'));fs.writeFileSync(path.join(dir,'intel','2026-10-01.json'),JSON.stringify({date:'2026-10-01',roles:[],tips:['existing']}));fs.writeFileSync(path.join(dir,'role-actions.json'),'preserve exact bytes');return dir;}
const role={id:'fixture-role',kind:'job',company:'Fixture',title:'Senior Backend Engineer',sourceUrl:'https://job-boards.greenhouse.io/fixture/jobs/12345678',checkedAt:'2026-10-10T10:00:00Z',fit:'Verified source'};
test('shared projection preserves native reports/actions and never invents recruiter jobs',t=>{const dir=fixture(t);const brief={opportunities:[role,{id:'r',kind:'recruiter',company:'Fixture',title:'Chat',checkedAt:role.checkedAt,sourceUrl:role.sourceUrl}]};const before=fs.readFileSync(path.join(dir,'intel','2026-10-01.json'));const dry=syncNativeIntel(dir,brief,{dryRun:true});assert.equal(dry.acceptedJobs,1);assert.equal(dry.excludedRecruiters,1);assert.equal(fs.readdirSync(path.join(dir,'intel')).length,1);const apply=syncNativeIntel(dir,brief);assert.equal(apply.changedReports,1);const report=JSON.parse(fs.readFileSync(path.join(dir,'intel','2026-10-10-career-review-migration.json')));assert.equal(report.roles[0].checkedAt,role.checkedAt);assert.equal(report.roles[0].role,role.title);assert.deepEqual(fs.readFileSync(path.join(dir,'intel','2026-10-01.json')),before);assert.equal(fs.readFileSync(path.join(dir,'role-actions.json'),'utf8'),'preserve exact bytes');assert.equal(syncNativeIntel(dir,brief).changedReports,0);});
test('unsupported listing and unverified date do not enter Intel',t=>{const dir=fixture(t);const result=syncNativeIntel(dir,{opportunities:[{...role,sourceUrl:'https://linkedin.com/jobs/'},{...role,id:'date',checkedAt:''}]});assert.equal(result.acceptedJobs,0);assert.equal(result.unsupportedJobs,2);assert.equal(fs.readdirSync(path.join(dir,'intel')).length,1);});
test('conflicting native migration report fails in preflight without touching historical state',t=>{const dir=fixture(t),file=path.join(dir,'intel','2026-10-10-career-review-migration.json');fs.writeFileSync(file,'{"date":"2026-10-10","roles":[]}');const before=fs.readFileSync(file);assert.throws(()=>syncNativeIntel(dir,{opportunities:[role]},{dryRun:true}),/unrelated/);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(dir,'migration-backups')),false);});


test('source-checked LinkedIn-only posting reaches native Intel and preserves employer verification limits', t => {
  const dir = fixture(t);
  const listing = {...role, sourceUrl: 'https://www.linkedin.com/jobs/view/4321098765/?trackingId=fixture', employerVerification: 'Employer shown on LinkedIn; independent employer verification unavailable', sourceLinks: ['https://www.linkedin.com/jobs/view/4321098765/']};
  const result = syncNativeIntel(dir, {opportunities: [listing]});
  assert.equal(result.acceptedJobs, 1);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'intel', '2026-10-10-career-review-migration.json')));
  assert.equal(report.roles[0].url, listing.sourceUrl);
  assert.equal(report.roles[0].employerVerification, listing.employerVerification);
  assert.deepEqual(report.roles[0].sourceLinks, listing.sourceLinks);
  assert.equal(fs.readFileSync(path.join(dir, 'role-actions.json'), 'utf8'), 'preserve exact bytes');
});

test('LinkedIn slug, tracking and host variants retain one native listing identity across imports', t => {
  const dir = fixture(t);
  const first = {...role, sourceUrl: 'https://linkedin.com/jobs/view/senior-backend-engineer-4321098765/?trk=fixture'};
  syncNativeIntel(dir, {opportunities: [first]});
  syncNativeIntel(dir, {opportunities: [{...first, sourceUrl: 'https://www.linkedin.com/jobs/view/4321098765/?refId=other', checkedAt: '2026-10-10T11:00:00Z'}]});
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'intel', '2026-10-10-career-review-migration.json')));
  assert.equal(report.roles.length, 1);
  assert.equal(report.roles[0].checkedAt, '2026-10-10T11:00:00Z');
});

test('LinkedIn search, missing job ID, misleading hosts and inbox links stay outside Discover', t => {
  const dir = fixture(t);
  const urls = ['https://www.linkedin.com/jobs/search/?currentJobId=4321098765', 'https://www.linkedin.com/jobs/view/senior-engineer', 'https://evil-linkedin.com/jobs/view/4321098765/', 'https://www.linkedin.com/messaging/thread/4321098765/', 'https://www.linkedin.com/jobs/view/4321098765/?q=engineer'];
  const result = syncNativeIntel(dir, {opportunities: urls.map((sourceUrl, i) => ({...role, id: `invalid-${i}`, sourceUrl}))});
  assert.equal(result.acceptedJobs, 0);
  assert.equal(result.unsupportedJobs, urls.length);
  assert.equal(fs.readdirSync(path.join(dir, 'intel')).length, 1);
});
