const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { behavioralResumeContext } = require('../lib/resume/grounding');
const { emptyMaster } = require('../lib/resume/master');
const { reviewSourceInfo } = require('../lib/jobs/review-source');
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jq-grounding-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
function saveMaster(dir) {
 const master={...emptyMaster(),contact:{name:'Fixture Candidate'},summary:'Actual platform ownership.',experience:[{id:'e',employer:'Fixture Employer',location:'NYC',start:'2020-01',end:'present',roles:[{id:'r',title:'Senior Engineer',team:'Product',start:'2020-01',end:'present',bullets:[{id:'b',text:'Led a documented migration.'}]}]}],skills:[{group:'Engineering',items:['Python','Kafka']}],additionalSections:[{title:'Leadership',body:'Mentored colleagues.'}]};
 fs.mkdirSync(path.join(dir,'resume'));fs.writeFileSync(path.join(dir,'resume/master.json'),JSON.stringify(master));return master;
}
test('Behavioral reads nested saved master facts and preserves source without falling back to stale request',t=>{
 const dir=fixture(t);saveMaster(dir);fs.writeFileSync(path.join(dir,'resume.json'),JSON.stringify({summary:'Legacy stale statement'}));
 const before=fs.readFileSync(path.join(dir,'resume/master.json'),'utf8');
 const context=behavioralResumeContext(dir,{summary:'Client stale statement'});
 assert.equal(context.source,'master');for(const fact of ['Fixture Employer','Senior Engineer','Led a documented migration.','Python','Kafka','Leadership','Mentored colleagues.'])assert.ok(context.content.includes(fact),fact);
 assert.doesNotMatch(context.content,/Legacy stale|Client stale|undefined|\[object Object\]/);assert.equal(fs.readFileSync(path.join(dir,'resume/master.json'),'utf8'),before);
});
test('legacy saved resume remains available when no master facts exist; corrupt master fails visibly',t=>{
 const dir=fixture(t);fs.writeFileSync(path.join(dir,'resume.json'),JSON.stringify({summary:'Legacy summary',experience:[{title:'Engineer',company:'Legacy Employer',duration:'2020–2022',bullets:['Shipped service.']}],skills:['Python']}));
 const context=behavioralResumeContext(dir);assert.equal(context.source,'legacy');assert.match(context.content,/Engineer · Legacy Employer/);assert.match(context.content,/Shipped service/);
 fs.mkdirSync(path.join(dir,'resume'));fs.writeFileSync(path.join(dir,'resume/master.json'),'{broken');assert.throws(()=>behavioralResumeContext(dir),SyntaxError);
});
function draftRoute(dataDir,onExec) {
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const start=source.indexOf("app.post('/api/behavioral/generate-draft'");const end=source.indexOf('// --- Interview Trainer ---',start);let handler,capturedPrompt;
 vm.runInNewContext(source.slice(start,end),{app:{post(_route,fn){handler=fn;}},DATA_DIR:dataDir,behavioralResumeContext,targetLevel:()=> 'Senior',fs:{...fs,writeFileSync(file,content,...args){capturedPrompt=content;return fs.writeFileSync(file,content,...args);}},path,os,__dirname:path.join(__dirname,'..'),console:{log(){},error(){}},process,require(id){if(id==='child_process')return {exec(_command,_options,callback){onExec(capturedPrompt);callback(null,'{"needsMoreInfo":true,"questions":["Which documented example?"]}','');}};return require(id);}});
 return handler;
}
test('actual generate-draft route prompts with saved native master rather than stale body; AI call mocked',t=>{
 const dir=fixture(t);saveMaster(dir);let prompt;
 const handler=draftRoute(dir,value=>{prompt=value;});let body;handler({body:{question:'Tell me about ownership',resumeData:{summary:'Stale client'},userContext:''}},{json(value){body=value;},status(){return this;}});
 assert.match(prompt,/saved native master/);assert.match(prompt,/Fixture Employer/);assert.match(prompt,/Led a documented migration/);assert.doesNotMatch(prompt,/Stale client/);assert.equal(body.needsMoreInfo,true);
});
test('job status distinguishes external configuration and migrated evidence from native generation readiness',t=>{
 const dir=fixture(t),reports=[{date:'2026-10-08',migration:{schema:'career-review-to-native-intel/1'},roles:[{checkedAt:'2026-10-08T12:00:00Z'}]}];
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const start=source.indexOf("app.get('/api/job-status'");const end=source.indexOf('// --- Resume File Upload ---',start);let handler;
 vm.runInNewContext(source.slice(start,end),{app:{get(_route,fn){handler=fn;}},getLocalDateStamp:()=> '2026-10-09',DATA_DIR:dir,path,fs,detectSchedule:()=>({installed:false}),localSetup:{schedule:'external'},process:{env:{JOB_QUEST_CAREER_BRIEF:'/fixture/brief.json'}},readDataDir:()=>reports,reviewSourceInfo,runtimeDisplayName:'Codex',runtimeCommandLabel:'codex',installScheduleCommand:'fixture'});
 let result;handler({}, {json(value){result=value;}});assert.equal(result.status,'pending');assert.equal(result.reviewSource.mode,'external');assert.equal(result.reviewSource.configured,true);assert.equal(result.reviewSource.externalRunVerification,'not_verified_by_native_status');assert.equal(result.reviewSource.migratedRoles,1);assert.equal(result.reviewSource.lastMigratedCheckAt,'2026-10-08T12:00:00Z');assert.equal(result.intel.ready,false);assert.equal(result.quiz.ready,false);assert.equal(result.tasks.ready,false);
});
