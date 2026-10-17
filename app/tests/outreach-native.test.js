const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {getPaths,ensureNativeStore,ingestCollection,withStoreLock} = require(process.env.OUTREACH_STORE_SOURCE || '../lib/outreach/store');
const {registerOpportunityRoutes} = require(process.env.OPPORTUNITIES_ROUTES_SOURCE || '../lib/opportunities/routes');
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const collection = (opportunities=[], generatedAt='2026-10-10T12:00:00Z') => ({schema:'job-quest-collection/1',generatedAt,summary:'Source-backed review',sources:[{name:'Configured mail',accountId:'mail-1',status:'partial',checkedAt:generatedAt,detail:'Bounded review'}],opportunities});
const recruiter = (id='reply-1') => ({id,kind:'recruiter',company:'Example Health',title:'Platform Engineer',channel:'email',sourceAccount:'mail-1',sourceUrl:`https://mail.google.com/mail/u/0/#all/${id}`,draftReply:'Thanks for reaching out. I would love to chat.',schedulingUrl:'https://calendly.com/example/recruiter',checkedAt:'2026-10-10T12:00:00Z'});
const job = (id='job-1') => ({id,kind:'job',company:'Example Health',title:'Backend Engineer',sourceUrl:'https://jobs.lever.co/example/12345678-abcd-1234-abcd-123456789abc',checkedAt:'2026-10-10T12:00:00Z'});
function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'jobquest-native-outreach-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  return {dataDir,...getPaths(dataDir)};
}
function routes(f,options={}) {
  const handlers={};
  const app=Object.fromEntries(['get','patch','put'].map(method=>[method,(url,fn)=>{handlers[`${method} ${url}`]=fn;}]));
  registerOpportunityRoutes(app,{dataDir:f.dataDir,...options});
  return (method,url,body,id)=>{
    let status=200,result;
    handlers[`${method} ${url}`]({body,params:{id}},{status(code){status=code;return this;},json(value){result=value;return this;}});
    return {status,body:result};
  };
}
function bytes(f) {return [fs.readFileSync(f.briefPath),fs.readFileSync(f.queuePath)];}

test('a fresh native no-config Outreach initializes private canonical stores and exposes an honest empty view',t=>{
  const f=fixture(t),call=routes(f),snapshot=call('get','/api/opportunities').body;
  assert.equal(f.briefPath,path.join(f.dataDir,'outreach/brief.json'));
  assert.equal(f.queuePath,path.join(f.dataDir,'outreach/queue.json'));
  assert.equal(snapshot.briefState,'ready'); assert.equal(snapshot.queueState,'ready');
  assert.deepEqual(snapshot.opportunities,[]); assert.deepEqual(snapshot.sources,[]);
  assert.equal(snapshot.generatedAt,null);
  for(const file of [f.briefPath,f.queuePath]) assert.equal(fs.statSync(file).mode & 0o777,0o600);
  assert.equal(fs.statSync(f.directory).mode & 0o777,0o700);
  const before=bytes(f); routes(f); assert.deepEqual(bytes(f),before);
});

test('explicit source overrides remain readable and are not replaced by empty native stores',t=>{
  const f=fixture(t),briefPath=path.join(f.dataDir,'legacy-brief.json'),queuePath=path.join(f.dataDir,'legacy-queue.json');
  fs.writeFileSync(briefPath,JSON.stringify(collection([recruiter()])));
  fs.writeFileSync(queuePath,JSON.stringify({items:[],holds:[{id:'reply-1',status:'hold_user',draftReply:'Keep this'}]}));
  const call=routes(f,{briefPath,queuePath});
  assert.equal(call('get','/api/opportunities').body.opportunities[0].draftReply,'Keep this');
  assert.equal(fs.existsSync(f.briefPath),false); assert.equal(fs.existsSync(f.queuePath),false);
  assert.equal(getPaths(f.dataDir,{briefPath,queuePath}).native,false);
});

test('a partial or malformed native store fails closed without replacing existing bytes',t=>{
  const f=fixture(t); fs.mkdirSync(f.directory);
  const malformed='{"items":[],"holds":"corrupt"}';fs.writeFileSync(f.queuePath,malformed);
  assert.throws(()=>ensureNativeStore(f.dataDir),/unavailable|malformed/);
  assert.equal(fs.readFileSync(f.queuePath,'utf8'),malformed); assert.equal(fs.existsSync(f.briefPath),false);
  fs.writeFileSync(f.briefPath,JSON.stringify(collection()));
  assert.throws(()=>ensureNativeStore(f.dataDir),/malformed/);
  assert.equal(fs.readFileSync(f.queuePath,'utf8'),malformed);
});

test('collection ingestion seeds actual drafts and native Intel listings without changing application state',t=>{
  const f=fixture(t),tracker={ 'Other|Role':{stage:'onsite',notes:'Keep'} },actions={saved:['Other|Role'],skipped:['Skipped|Role'],applied:[]};
  const trackerFile=path.join(f.dataDir,'role-tracker.json'),actionsFile=path.join(f.dataDir,'role-actions.json');
  fs.writeFileSync(trackerFile,JSON.stringify(tracker));fs.writeFileSync(actionsFile,JSON.stringify(actions));
  const r=recruiter();r.preparedDraft='Thanks. I would love to connect.';
  const result=ingestCollection({dataDir:f.dataDir,collection:collection([r,job(),{...job('generic-job'),sourceUrl:'https://example.com/careers'}])});
  const queue=read(f.queuePath); assert.equal(queue.items.length,1);assert.equal(queue.items[0].draftReply,r.preparedDraft);
  assert.equal(queue.items[0].status,'ready_for_review');assert.equal(queue.items[0].sentAt,undefined);assert.equal(queue.items[0].reminderCount,0);
  const report=read(path.join(f.dataDir,'intel/2026-10-10-career-review-migration.json'));
  assert.deepEqual(report.roles.map(role=>`${role.company}|${role.role}`),['Example Health|Backend Engineer']);
  assert.equal(result.intel.unsupportedJobs,1);
  assert.equal(fs.readFileSync(trackerFile,'utf8'),JSON.stringify(tracker));assert.equal(fs.readFileSync(actionsFile,'utf8'),JSON.stringify(actions));
  assert.ok(result.backupDir);assert.equal(fs.statSync(result.backupDir).mode & 0o777,0o700);
});

test('collector data cannot overwrite edited drafts, sent/hold/snooze/reminder decisions or remove absent history',t=>{
  const f=fixture(t);ensureNativeStore(f.dataDir);
  const saved={version:7,customRoot:{keep:true},updatedAt:'2026-10-09T10:00:00Z',items:[{id:'reply-1',draftReply:'User-edited exact draft',status:'awaiting_recruiter',sentAt:'2026-10-09T08:00:00Z',sentChannel:'linkedin',reminderCount:2,nextReminderAt:null,verification:'user_reported',custom:{keep:true}},{id:'absent',draftReply:'',status:'snoozed',nextReminderAt:'2090-01-01T12:00:00Z'}],holds:[{id:'held',draftReply:'Held draft',status:'hold_user',reminderCount:2,reviewResumedAt:'2026-10-01T12:00:00Z',reminderResumeHistory:[{keep:true}]}]};
  fs.writeFileSync(f.queuePath,JSON.stringify(saved));
  const incoming={...recruiter(),draftReply:'Collector stale draft',status:'ready_for_review',reminderCount:0,sentAt:null};
  ingestCollection({dataDir:f.dataDir,collection:collection([incoming,recruiter('held'),recruiter('new')])});
  const after=read(f.queuePath);assert.deepEqual(after.items.slice(0,2),saved.items);assert.deepEqual(after.holds,saved.holds);assert.deepEqual(after.customRoot,saved.customRoot);
  assert.equal(after.items[2].id,'new');assert.equal(after.items[2].draftReply,recruiter('new').draftReply);
  const snapshot=routes(f)('get','/api/opportunities').body;
  assert.equal(snapshot.opportunities.find(item=>item.id==='reply-1').status,'awaiting_recruiter');
  assert.equal(snapshot.opportunities.find(item=>item.id==='held').editable,true);
});

test('without new recruiter records collection preserves exact queue bytes, cleared drafts and existing coverage',t=>{
  const f=fixture(t);ensureNativeStore(f.dataDir);
  const raw='{"version":1, "custom": [3,2,1], "items":[{"id":"reply-1","draftReply":"","status":"hold_user"}], "holds":[]}\n';
  fs.writeFileSync(f.queuePath,raw);
  ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()])});
  assert.equal(fs.readFileSync(f.queuePath,'utf8'),raw);
  const first=fs.readFileSync(f.briefPath,'utf8');
  ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()])});
  assert.equal(fs.readFileSync(f.queuePath,'utf8'),raw);assert.equal(fs.readFileSync(f.briefPath,'utf8'),first);
  assert.equal(routes(f)('get','/api/opportunities').body.opportunities[0].draftReply,'');
  const next=collection([], '2026-10-11T12:00:00Z');next.sources=[{name:'Unavailable account',accountId:'mail-2',status:'blocked',detail:'Not connected'}];
  ingestCollection({dataDir:f.dataDir,collection:next});
  assert.equal(read(f.briefPath).opportunities.length,1);assert.equal(read(f.briefPath).sources.length,2);
  assert.equal(read(f.briefPath).sources.find(source=>source.accountId==='mail-2').checkedAt,undefined);
});

test('stale whole collections reject and older per-record/source checks do not replace newer evidence',t=>{
  const f=fixture(t);ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()])});const before=bytes(f);
  assert.throws(()=>ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()], '2026-10-09T12:00:00Z')}),error=>error.status===409);
  assert.deepEqual(bytes(f),before);
  const next=collection([{...recruiter(),checkedAt:'2026-10-08T12:00:00Z',sourceUrl:'https://example.com/older'}],'2026-10-11T12:00:00Z');next.sources[0].checkedAt='2026-10-08T12:00:00Z';
  ingestCollection({dataDir:f.dataDir,collection:next});
  assert.equal(read(f.briefPath).opportunities[0].sourceUrl,recruiter().sourceUrl);assert.equal(read(f.briefPath).sources[0].checkedAt,'2026-10-10T12:00:00Z');assert.deepEqual(fs.readFileSync(f.queuePath),before[1]);
});

test('malformed input and replacement queues reject before creating native stores',t=>{
  for(const input of [{...collection(),queue:{items:[],holds:[]}},collection([recruiter(),recruiter()]),collection([{...recruiter(),sourceUrl:'https://user:password@example.com/message'}]),{...collection(),generatedAt:'yesterday'}]) {
    const f=fixture(t);assert.throws(()=>ingestCollection({dataDir:f.dataDir,collection:input}));assert.equal(fs.existsSync(f.briefPath),false);assert.equal(fs.existsSync(f.queuePath),false);
  }
});

test('native Intel conflicts fail before replacing the collected brief or user queue',t=>{
  const f=fixture(t);ensureNativeStore(f.dataDir);const before=bytes(f);
  fs.mkdirSync(path.join(f.dataDir,'intel'));const report=path.join(f.dataDir,'intel/2026-10-10-career-review-migration.json');fs.writeFileSync(report,'{"unrelated":true}');
  assert.throws(()=>ingestCollection({dataDir:f.dataDir,collection:collection([job(),recruiter()])}),/unrelated/);
  assert.deepEqual(bytes(f),before);assert.equal(fs.readFileSync(report,'utf8'),' {"unrelated":true}'.trim());
});

test('collector and user PATCH share a lock and stale item revisions remain rejected afterward',t=>{
  const f=fixture(t);ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()])});const call=routes(f);const initial=call('get','/api/opportunities').body.opportunities[0];
  withStoreLock(f.dataDir,()=>{
    assert.throws(()=>ingestCollection({dataDir:f.dataDir,collection:collection()}),error=>error.status===409);
    const response=call('patch','/api/opportunities/:id',{revision:initial.revision,action:'draft',draftReply:'During collector'},initial.id);assert.equal(response.status,409);
  });
  assert.equal(call('patch','/api/opportunities/:id',{revision:initial.revision,action:'draft',draftReply:'After collector'},initial.id).status,200);
  const stale=call('patch','/api/opportunities/:id',{revision:initial.revision,action:'hold'},initial.id);assert.equal(stale.status,409);
  ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()],'2026-10-11T12:00:00Z')});
  assert.equal(read(f.queuePath).items[0].draftReply,'After collector');assert.equal(fs.existsSync(path.join(f.directory,'.write.lock')),false);
});

test('a publication failure rolls back brief, queue and existing Intel bytes while keeping backups',t=>{
  const f=fixture(t);ingestCollection({dataDir:f.dataDir,collection:collection([recruiter(),job()])});const before=bytes(f);const report=path.join(f.dataDir,'intel/2026-10-10-career-review-migration.json'),reportBefore=fs.readFileSync(report);
  const rename=fs.renameSync;let failed=false;
  t.mock.method(fs,'renameSync',(from,to)=>{if(to===report && !failed){failed=true;throw Error('Fixture report publication failed');}return rename(from,to);});
  const next=collection([recruiter('new'),{...job(),fit:'Updated actual evidence'}],'2026-10-11T12:00:00Z');
  assert.throws(()=>ingestCollection({dataDir:f.dataDir,collection:next}),/Fixture/);
  assert.deepEqual(bytes(f),before);assert.deepEqual(fs.readFileSync(report),reportBefore);
  assert.ok(fs.readdirSync(path.join(f.directory,'backups')).length>=2);assert.equal(fs.existsSync(path.join(f.directory,'.write.lock')),false);
});

test('actual fixture server exposes native no-config setup, editable collected outreach and common Intel',async t=>{
  const f=fixture(t);
  const {withServer}=require('./helpers/server');
  await withServer(f.dataDir,async base=>{
    const setup=await (await fetch(`${base}/api/local-setup`)).json();
    assert.equal(setup.outreachStorage,'native');assert.equal(setup.careerBriefConfigured,true);assert.equal(setup.replyQueueConfigured,true);
    assert.equal(setup.privateConfigured,false);assert.equal(setup.schedule,'not_selected');
    const empty=await (await fetch(`${base}/api/opportunities`)).json();assert.equal(empty.briefState,'ready');assert.deepEqual(empty.opportunities,[]);
    ingestCollection({dataDir:f.dataDir,collection:collection([recruiter(),job()])});
    const snapshot=await (await fetch(`${base}/api/opportunities`)).json();const reply=snapshot.opportunities.find(item=>item.id==='reply-1');
    assert.equal(reply.editable,true);assert.equal(reply.schedulingUrl,recruiter().schedulingUrl);
    const edited=await fetch(`${base}/api/opportunities/reply-1`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({revision:reply.revision,action:'draft',draftReply:'Edited through the actual route'})});
    assert.equal(edited.status,200);
    ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()],'2026-10-11T12:00:00Z')});
    const after=await (await fetch(`${base}/api/opportunities`)).json();assert.equal(after.opportunities.find(item=>item.id==='reply-1').draftReply,'Edited through the actual route');
    const intel=await (await fetch(`${base}/api/intel`)).json();assert.ok(intel.flatMap(report=>report.roles || []).some(role=>role.company==='Example Health' && role.role==='Backend Engineer'));
  },{JOB_QUEST_CAREER_BRIEF:'',JOB_QUEST_REPLY_QUEUE:'',JOB_QUEST_ALLOWED_ORIGINS:'',JOB_QUEST_TAILSCALE_USER:''});
});


test('a queue corrupted after startup cannot be rewritten through user PATCH', t => {
  const f=fixture(t);ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()])});const call=routes(f);const initial=call('get','/api/opportunities').body.opportunities[0];
  const malformed={...read(f.queuePath),holds:'unreadable'};const raw=JSON.stringify(malformed);fs.writeFileSync(f.queuePath,raw);
  assert.equal(call('patch','/api/opportunities/:id',{revision:initial.revision,action:'draft',draftReply:'Do not overwrite'},initial.id).status,503);
  assert.equal(fs.readFileSync(f.queuePath,'utf8'),raw);
});

test('a real fixture child exiting inside its lock leaves a dead owner that the next write recovers', t => {
  const {spawnSync}=require('node:child_process');const f=fixture(t);
  const child=spawnSync(process.execPath,['-e',`const store=require(process.argv[1]);store.withStoreLock(process.argv[2],()=>process.exit(0));`,require.resolve('../lib/outreach/store'),f.dataDir],{encoding:'utf8',timeout:3000});
  assert.equal(child.status,0,child.stderr);
  const lock=path.join(f.directory,'.write.lock');const abandoned=read(path.join(lock,'owner.json'));
  assert.ok(Number.isInteger(abandoned.pid));assert.equal(abandoned.schema,'job-quest-outreach-lock/1');
  assert.equal(fs.statSync(path.join(lock,'owner.json')).mode & 0o777,0o600);
  const result=ingestCollection({dataDir:f.dataDir,collection:collection([recruiter()])});
  assert.equal(result.queuedRecruiters,1);assert.equal(fs.existsSync(lock),false);
  assert.equal(fs.readdirSync(f.directory).some(name=>name.includes('.stale-') || name.endsWith('.recovery')),false);
});

test('an actual live fixture writer remains protected until it releases its lock', async t => {
  const {spawn}=require('node:child_process');const f=fixture(t);
  const child=spawn(process.execPath,['-e',`const fs=require('node:fs'),store=require(process.argv[1]);store.withStoreLock(process.argv[2],()=>{process.stdout.write('ready\\n');fs.readSync(0,Buffer.alloc(1),0,1,null);});`,require.resolve('../lib/outreach/store'),f.dataDir],{stdio:['pipe','pipe','pipe'],timeout:4000});
  t.after(()=>child.stdin.end());
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
  const lock=path.join(f.directory,'.write.lock'),before=fs.readFileSync(path.join(lock,'owner.json'));
  assert.equal(read(path.join(lock,'owner.json')).pid,child.pid);
  assert.throws(()=>ingestCollection({dataDir:f.dataDir,collection:collection()}),error=>error.status===409);
  assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),before);assert.equal(fs.existsSync(f.briefPath),false);
  child.stdin.end('x');assert.equal(await exit,0);assert.equal(fs.existsSync(lock),false);
  ensureNativeStore(f.dataDir);assert.equal(read(f.briefPath).opportunities.length,0);
});

test('unknown lock ownership and permission-denied owner probes never authorize recovery', t => {
  const f=fixture(t),lock=path.join(f.directory,'.write.lock');fs.mkdirSync(lock,{recursive:true});
  assert.throws(()=>ensureNativeStore(f.dataDir),error=>error.status===409);
  const malformed='{"pid":1,"nonce":"unknown"}';fs.writeFileSync(path.join(lock,'owner.json'),malformed);
  assert.throws(()=>ensureNativeStore(f.dataDir),error=>error.status===409);assert.equal(fs.readFileSync(path.join(lock,'owner.json'),'utf8'),malformed);
  fs.rmSync(lock,{recursive:true});
  withStoreLock(f.dataDir,()=>{
    const before=fs.readFileSync(path.join(lock,'owner.json'));
    t.mock.method(process,'kill',(_pid,signal)=>{assert.equal(signal,0);throw Object.assign(Error('Fixture probe denied'),{code:'EPERM'});});
    assert.throws(()=>ensureNativeStore(f.dataDir),error=>error.status===409);assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),before);
  });
  assert.equal(fs.existsSync(lock),false);
});

test('lock cleanup never removes owner metadata whose nonce changed',t=>{
  const f=fixture(t),lock=path.join(f.directory,'.write.lock');let replaced;
  withStoreLock(f.dataDir,()=>{
    replaced={...read(path.join(lock,'owner.json')),nonce:require('node:crypto').randomUUID()};fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify(replaced));
  });
  assert.deepEqual(read(path.join(lock,'owner.json')),replaced);
});
