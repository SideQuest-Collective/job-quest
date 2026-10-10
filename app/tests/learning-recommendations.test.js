const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/learning/store');
const { recommendations } = require('../lib/learning/recommendations');
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-recommendation-')); t.after(() => fs.rmSync(dir, {recursive:true,force:true})); return dir; };
const write = (dir, file, value) => { fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true}); fs.writeFileSync(path.join(dir,file),JSON.stringify(value)); };
const empty = {sources:[],sessions:[]};
const problem = {id:'rain',title:'Rain Water',category:'arrays-hashing',tags:['two-pointer'],description:'PRIVATE SOLUTION SCAFFOLDING'};

test('current plan and saved work merge by exact destination, with old/future/completed states honest', t => {
  const dir=fixture(t);
  write(dir,'problems/progress.json',{savedCode:{rain:'saved'},solved:{done:true}});
  write(dir,'tasks/2026-10-09.json',{tasks:[{text:'Resume Rain Water',planId:'six-week',link:{kind:'codelab',problemId:'rain'},minutes:25},{text:'Behavioral rep',category:'behavioral',minutes:15},{text:'Different behavioral rep',category:'behavioral',minutes:15},{text:'Done',completed:true,problemId:'done'}]});
  write(dir,'tasks/2026-10-08.json',{tasks:[{text:'Older duplicate',problemId:'rain'}]});
  write(dir,'tasks/2099-01-01.json',{tasks:[{text:'Future',problemId:'future'}]});
  const before=fs.readFileSync(path.join(dir,'tasks/2026-10-09.json'),'utf8');
  const {choices}=store.quickChoices(dir,()=>({problems:[problem]}),{now:new Date(2026,9,9)});
  assert.equal(choices[0].title,'Resume Rain Water'); assert.equal(choices[0].planId,'six-week');
  assert.equal(choices[0].saved,true); assert.match(choices[0].reason,/today.*saved/);
  assert.equal(choices.filter(c=>c.href==='/?problem=rain').length,1);
  assert.equal(choices.filter(c=>c.href==='/#behavioral').length,2);assert.ok(!choices.some(c=>/Future|Done|Older/.test(c.title)));
  const result=recommendations(dir,{choices,state:empty});
  assert.equal(result.recommendations[5][0].kind,'retrieval');
  assert.ok(!result.recommendations[5][0].prompt.includes('SCAFFOLDING'));
  for(const n of [15,30]) {assert.equal(result.recommendations[n][0].href,'/?problem=rain');assert.equal(result.recommendations[n][0].kind,'native');}
  assert.equal(fs.readFileSync(path.join(dir,'tasks/2026-10-09.json'),'utf8'),before);
});

test('media matches precise concept evidence and preserves a concrete follow-up destination', t=>{
  const dir=fixture(t);
  const choices=[{id:'rain',title:'Rain Water',href:'/?problem=rain',tags:['two-pointer'],category:'arrays-hashing'},{id:'anagrams',title:'Group Anagrams',href:'/?problem=anagrams',tags:['hash-map'],reason:'Your plan',planId:'week1'},{id:'design',title:'Availability zones and failover',href:'/?sd=resilience',reason:'Earlier session'}];
  const media=recommendations(dir,{choices,state:empty}).media;
  const hash=media.find(m=>m.id==='media:mit-hashing');assert.equal(hash.planContext.href,'/?problem=anagrams');assert.match(hash.goal,/Group Anagrams/);assert.match(hash.reflection,/Group Anagrams/);
  assert.equal(media.find(m=>m.kind==='audio').planContext.href,'/?sd=resilience');
  const fallback=recommendations(dir,{choices:[choices[0]],state:empty}).media.find(m=>m.id==='media:mit-hashing');assert.equal(fallback.matched,false);assert.equal(fallback.planContext.href,'/#codelab');
});

test('only latest completed real reviewed answers with gaps recommend next reps; failures and mismatched answers do not', t=>{
  const dir=fixture(t);
  const good={id:'review_one',kind:'behavioral',questionId:'q',source:'behavioral',answer:'Actual fixture answer',status:'done',createdAt:'2026-10-09T10:00:00Z',evaluation:{score:6,maxScore:10,improvements:['State a concrete trade-off'],nextRep:'Give one decision and its cost'}};
  write(dir,'feedback/good.json',good);
  write(dir,'feedback/failed.json',{...good,id:'failed',questionId:'fail',status:'failed'});
  write(dir,'feedback/blank.json',{...good,id:'blank',questionId:'blank',answer:''});
  write(dir,'feedback/mismatch.json',{...good,id:'mismatch',source:'learning',questionId:'learning_x'});
  let reps=recommendations(dir,{choices:[],state:empty}).recommendations[5];
  assert.equal(reps.length,1);assert.match(reps[0].prompt,/Give one decision and its cost/);assert.equal(reps[0].planContext.feedbackAttemptId,'review_one');
  write(dir,'feedback/newer.json',{...good,id:'newer',createdAt:'2026-10-09T11:00:00Z',evaluation:{score:9,maxScore:10,improvements:[],nextRep:'Continue'}});
  assert.equal(recommendations(dir,{choices:[],state:empty}).recommendations[5].length,0);
});

test('review follow-up uses exact learning answer/reference and matching provenance, never an invented concept',t=>{
  const dir=fixture(t);
  const state={sources:[{id:'concept:maps',kind:'concept',title:'Maps',content:'Reference',sha256:'current'}],sessions:[{id:'learn_one',status:'answered',kind:'retrieval',sourceId:'concept:maps',goal:'Explain maps',prompt:'When use a map?',response:'Fixture answer',planContext:{choiceId:'task1',title:'Maps task',href:'/?problem=maps'}}]};
  write(dir,'feedback/learn.json',{id:'learn_one',source:'learning',kind:'behavioral',questionId:'learning_learn_one',answer:'Fixture answer',status:'done',evaluation:{score:5,maxScore:10,improvements:['Explain collisions'],nextRep:'Use a collision example'}});
  const rep=recommendations(dir,{choices:[],state}).recommendations[15][0];
  assert.equal(rep.reference.sha256,'current');assert.equal(rep.planContext.href,'/?problem=maps');assert.match(rep.prompt,/collision example/);
  state.sessions[0].goal='';state.sessions[0].planContext=null;assert.equal(recommendations(dir,{choices:[],state}).recommendations[5][0].goal,'Maps');
  state.sessions[0].response='Changed';assert.equal(recommendations(dir,{choices:[],state}).recommendations[15].length,0);
});

test('saved goal and practice link survive bookmark/answer continuation, and cannot be retargeted',t=>{
  const dir=fixture(t);
  const session={id:'planned_media',kind:'media',sourceId:'media:mit-hashing',minutes:15,status:'draft',response:'',prompt:'Apply this to maps',goal:'Prepare maps',planContext:{choiceId:'task1',title:'Maps',href:'/?problem=maps',planId:'week1'},positionSeconds:80};
  store.saveSession(dir,{revision:0,session});
  let result=store.saveSession(dir,{revision:1,session:{...session,positionSeconds:120,response:'Fixture reflection',status:'answered'}});
  assert.equal(result.sessions[0].planContext.planId,'week1');assert.equal(result.sessions[0].positionSeconds,120);assert.equal(result.sessions[0].feedback.score,null);
  const other={...session,id:'planned_other'};
  store.saveSession(dir,{revision:2,session:other});
  assert.throws(()=>store.saveSession(dir,{revision:3,session:{...other,planContext:{...other.planContext,href:'/?problem=other'}}}),/different practice goal/);
  assert.throws(()=>store.saveSession(dir,{revision:3,session:{...session,id:'external_link',planContext:{...session.planContext,href:'https://example.com'}}}),/local practice/);
});

test('coach-provided follow-up keeps its assistance context even if the client unchecks help',t=>{
  const dir=fixture(t);
  const session={id:'coached_rep',kind:'retrieval',sourceId:'builtin:practice-check',minutes:5,status:'answered',response:'Fixture rep',goal:'Address a gap',prompt:'Coach asks for a specific trade-off',assisted:false,planContext:{choiceId:'feedback:prior',title:'Prior answer',feedbackAttemptId:'prior'}};
  assert.equal(store.saveSession(dir,{revision:0,session}).sessions[0].assisted,true);
});

test('durable workbook feedback links only the verified current question, without changing learner grades',t=>{
 const dir=fixture(t),workbook=require('../lib/workbook/store'),crypto=require('crypto');
 const meta=workbook.createMinimalWorkbook(dir,{roleKey:'Fixture|Engineer',company:'Fixture',role:'Engineer'});
 workbook.appendChapterQuestions(dir,meta.id,{questions:[{id:'q1',markup:'@@q id=q1 company=both topic=Concurrency type=open diff=2 chapter=asked-in-interviews\nExplain a queue trade-off.\n@@answer\nReference.'}]});
 const q=workbook.loadParsed(dir,meta.id).questions[0];assert.ok(q);
 const key='wb_'+crypto.createHash('sha256').update(JSON.stringify([meta.id,q.id])).digest('hex');
 const a={id:'workbook_review',kind:'behavioral',source:'workbook',questionId:key,answer:'Actual fixture answer',context:{question:q.body},assistance:{workbookId:meta.id,questionId:q.id,revealed:true},status:'done',evaluation:{score:5,maxScore:10,improvements:['State the ordering guarantee'],nextRep:'Explain one ordering trade-off'}};
 write(dir,'feedback/workbook_review.json',a);
 const before=fs.readFileSync(path.join(workbook.wbDir(dir,meta.id),'progress.json'),'utf8');
 const rep=recommendations(dir,{state:empty}).recommendations[5][0];assert.ok(rep);assert.equal(rep.planContext.href,`/workbooks/${meta.id}#question/${encodeURIComponent(q.id)}`);assert.equal(rep.planContext.feedbackAttemptId,a.id);assert.match(rep.prompt,/ordering trade-off/);
 assert.equal(fs.readFileSync(path.join(workbook.wbDir(dir,meta.id),'progress.json'),'utf8'),before);
 for(const bad of [{questionId:'wb_wrong'},{assistance:{workbookId:meta.id,questionId:'missing'}},{context:{question:'Changed source'}}]){write(dir,'feedback/workbook_review.json',{...a,...bad});assert.equal(recommendations(dir,{state:empty}).recommendations[5].length,0);}
});
test('five-minute recall uses exact known concepts while general tasks remain optional planning',t=>{
 const dir=fixture(t);const choices=[{id:'map',title:'Group Anagrams',href:'/?problem=anagrams',tags:['hash-map']},{id:'rain',title:'Rain Water',href:'/?problem=rain',category:'arrays-hashing',tags:['two-pointer']}];
 const reps=recommendations(dir,{state:empty,choices}).recommendations[5];assert.equal(reps[0].reference.id,'builtin:hashing');assert.equal(reps[0].conceptRecall,true);assert.match(reps[0].prompt,/from memory/);assert.equal(reps[0].planContext.href,choices[0].href);assert.match(reps[1].title,/Optional planning/);assert.equal(reps[1].reference.id,'builtin:practice-check');
 const session={id:'hash_recall',kind:'retrieval',sourceId:'builtin:hashing',minutes:5,status:'answered',response:'Fixture recall',goal:'Recall hashing',prompt:reps[0].prompt,planContext:reps[0].planContext};
 const saved=store.saveSession(dir,{revision:0,session}).sessions[0];assert.match(saved.sourceSnapshot.content,/Collisions/);assert.ok(saved.sourceSnapshot.sha256);assert.equal(saved.feedback.score,null);
});
