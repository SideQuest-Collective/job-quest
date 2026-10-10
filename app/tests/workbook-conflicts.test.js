const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const store=require('../lib/workbook/store');
const {normalizeProgress,mergeProgress}=require('../lib/workbook/progress');
const {registerWorkbookRoutes}=require('../lib/workbook/routes');
const fixture=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jq-workbook-conflict-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const grade={grade:'partial',at:'2026-10-08T12:00:00.000Z',source:'trainer'};
const response=(status,body)=>({status,ok:status<400,json:async()=>body});
function routesFor(dir){const routes=new Map(),app=Object.fromEntries(['get','post','put','delete'].map(m=>[m,(url,fn)=>routes.set(`${m} ${url}`,fn)]));registerWorkbookRoutes(app,{dataDir:dir,queue:{list:()=>[]},autoBuild:{},publicDir:path.resolve(__dirname,'../public')});return (id,body)=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};routes.get('put /api/workbooks/:id/progress')({params:{id},body},res);return res;};}

test('migrated progress reads without writes, revisions reject stale device without changing bytes or grade history',t=>{
 const dir=fixture(t),meta=store.createWorkbook(dir,{roleKeys:['Example|Engineer']});
 const file=path.join(store.wbDir(dir,meta.id),'progress.json');
 fs.writeFileSync(file,JSON.stringify({version:1,answers:{q1:'Initial'},grades:{q1:grade},history:{q1:[grade]},ui:{picks:{q1:{revealed:true}}}}));
 const original=fs.readFileSync(file,'utf8');assert.equal(store.readProgress(dir,meta.id).revision,0);assert.equal(fs.readFileSync(file,'utf8'),original);
 const put=routesFor(dir),first=put(meta.id,{expectedRevision:0,answers:{q1:'Mac edit'},ui:{picks:{q1:{assisted:true}}}});
 assert.equal(first.statusCode,200);assert.equal(first.body.revision,1);
 const before=fs.readFileSync(file,'utf8');const stale=put(meta.id,{expectedRevision:0,answers:{q1:'Stale phone edit'},ui:{picks:{}}});
 assert.equal(stale.statusCode,409);assert.equal(stale.body.current.answers.q1,'Mac edit');assert.equal(fs.readFileSync(file,'utf8'),before);
 const next=put(meta.id,{expectedRevision:1,answers:{q1:'Reviewed edit'},ui:{picks:{q1:{revealed:false,assisted:false,hintUsed:true}}}});
 assert.deepEqual(next.body.ui.picks.q1,{revealed:true,assisted:true,hintUsed:true});assert.deepEqual(next.body.history.q1,[grade]);assert.deepEqual(next.body.grades.q1,grade);
});
test('legacy clients can add answers/grades, but unversioned replacements fail safely; malformed revisions cannot write',t=>{
 const dir=fixture(t),meta=store.createWorkbook(dir,{roleKeys:['Example|Engineer']}),put=routesFor(dir);
 assert.equal(put(meta.id,{answers:{q1:'Legacy addition'}}).statusCode,200);
 assert.equal(put(meta.id,{grades:{q1:grade},answers:{q2:'Another answer'}}).statusCode,200);
 const before=JSON.stringify(store.readProgress(dir,meta.id));
 assert.equal(put(meta.id,{answers:{q1:'Unversioned replacement'}}).statusCode,409);
 for(const value of [-1,'2',2.5])assert.equal(put(meta.id,{expectedRevision:value,answers:{q1:'Bad'}}).statusCode,400);
 assert.equal(JSON.stringify(store.readProgress(dir,meta.id)),before);
});
test('omitted/null picks and native grade writers cannot erase recorded help, and native grades advance the revision',t=>{
 let p=mergeProgress(null,{answers:{q:'Answer'},ui:{picks:{q:{assisted:true,revealed:true,hintUsed:true},other:{assisted:true}}}});
 p=mergeProgress(p,{ui:{picks:null}});assert.equal(p.ui.picks.q.revealed,true);
 p=mergeProgress(p,{ui:{picks:{q:{pick:1}}}});assert.equal(p.ui.picks.other.assisted,true);assert.equal(p.ui.picks.q.assisted,true);
 const before=p.revision;p=mergeProgress(p,{grades:{q:grade}});assert.equal(p.revision,before+1);assert.equal(p.ui.picks.q.hintUsed,true);
 assert.throws(()=>mergeProgress(p,{expectedRevision:before,answers:{q:'Stale'}}),e=>e.status===409);
});

const html=fs.readFileSync(path.resolve(__dirname,'../public/workbook.html'),'utf8');
const harness=fs.readFileSync(path.join(__dirname,'workbook-viewer.test.js'),'utf8');
let helper=harness.slice(harness.indexOf('async function loadViewer('),harness.indexOf("test('a viewer answer save"));
helper=helper.replace('putResponse } = {})','putResponse, getProgress } = {})');
helper=helper.replace('json: async () => clone(progress)','json: async () => getProgress ? getProgress() : clone(progress)');
const loadViewer=new Function('vm','clone','html','assert',helper+';return loadViewer;')(vm,value=>JSON.parse(JSON.stringify(value)),html,assert);
function backend(initial){let current=normalizeProgress(initial);return {read:()=>JSON.parse(JSON.stringify(current)),put:async payload=>{try{current=mergeProgress(current,payload);return response(200,current);}catch(e){return response(e.status,{error:e.message,current:e.current});}},change:fn=>{current=fn(current);}};}

test('two browser race preserves latest server answers, local drafts and help; explicit rebase keeps only edited questions',async()=>{
 const server=backend({answers:{q1:'Original one',q2:'Original two'},grades:{q1:grade},history:{q1:[grade]}});
 const a=await loadViewer({progress:server.read(),putResponse:server.put,getProgress:server.read}),b=await loadViewer({progress:server.read(),putResponse:server.put,getProgress:server.read});
 a.api.S.draft.q1='New Mac one';a.api.S.ans.q1.assisted=true;await a.api.flush();
 b.api.S.draft.q2='Phone two';b.api.S.ans.q2={revealed:true};assert.equal(await b.api.flush(),false);
 assert.equal(server.read().answers.q2,'Original two');assert.equal(b.api.S.draft.q2,'Phone two');assert.match(b.api.conflictMarkup(),/New Mac one/);
 assert.equal(JSON.parse(b.storage.get('workbook.sample.pending')).answers.q2,'Phone two');
 await b.api.resolveConflict(false);
 assert.deepEqual(server.read().answers,{q1:'New Mac one',q2:'Phone two'});assert.equal(server.read().ui.picks.q1.assisted,true);assert.equal(server.read().ui.picks.q2.revealed,true);
 assert.deepEqual(server.read().history.q1,[grade]);assert.equal(b.storage.has('workbook.sample.pending'),false);
});
test('reload of a stale pending draft keeps original revision and text rather than silently rebasing onto newer answers',async()=>{
 const server=backend({revision:4,answers:{q1:'Saved new'},ui:{picks:{q1:{revealed:true}}}});
 const pending={expectedRevision:2,answers:{q1:'Browser pending'},ui:{picks:{q1:{assisted:true}}},baseProgress:{revision:2,answers:{q1:'Older base'}}};
 const viewer=await loadViewer({progress:server.read(),stored:{'workbook.sample.pending':JSON.stringify(pending)},putResponse:server.put,getProgress:server.read});await new Promise(setImmediate);
 assert.equal(viewer.puts[0].expectedRevision,2);assert.equal(viewer.api.S.draft.q1,'Browser pending');assert.equal(server.read().answers.q1,'Saved new');
 assert.equal(viewer.api.S.ans.q1.revealed,true);assert.equal(viewer.api.S.ans.q1.assisted,true);assert.match(viewer.api.conflictMarkup(),/Browser pending/);
});
test('using saved answers retains browser backup and exposures, and restoring backup never silently overwrites saved text',async()=>{
 const server=backend({answers:{q1:'Original'}}),viewer=await loadViewer({progress:server.read(),putResponse:server.put,getProgress:server.read});
 viewer.api.S.draft.q1='Local edit';viewer.api.S.ans.q1={revealed:true};server.change(p=>mergeProgress(p,{answers:{q1:'Other device'}}));
 await viewer.api.flush();await viewer.api.resolveConflict(true);assert.equal(viewer.api.S.draft.q1,'Other device');assert.equal(server.read().ui.picks.q1.revealed,true);
 const backup=JSON.parse(viewer.storage.get('workbook.sample.conflict-backup'));assert.equal(backup.answers.q1,'Local edit');
 viewer.api.restoreBrowserDraft();await new Promise(setImmediate);assert.equal(viewer.api.S.draft.q1,'Local edit');assert.equal(server.read().answers.q1,'Other device');assert.equal(viewer.storage.has('workbook.sample.pending'),true);
});
test('queued writes use the acknowledged revision and a completed earlier save cannot erase newer browser pending edits',async()=>{
 const server=backend({answers:{q1:'Original'}});let release;
 const viewer=await loadViewer({progress:server.read(),getProgress:server.read,putResponse:payload=>new Promise(r=>{release=async()=>r(await server.put(payload));})});
 viewer.api.S.draft.q1='First';const first=viewer.api.flush();await new Promise(setImmediate);
 viewer.api.S.draft.q1='Second';viewer.api.save();release();await first;
 assert.equal(JSON.parse(viewer.storage.get('workbook.sample.pending')).answers.q1,'Second');
 const second=viewer.api.flush();await new Promise(setImmediate);assert.equal(viewer.puts[1].expectedRevision,1);release();await second;
 assert.equal(server.read().answers.q1,'Second');assert.equal(viewer.storage.has('workbook.sample.pending'),false);
});

test('another write during conflict resolution still rejects the rebase and retains the edited browser response',async()=>{
 const server=backend({answers:{q1:'Original'}});let interfere=false;
 const viewer=await loadViewer({progress:server.read(),putResponse:async payload=>{if(interfere){server.change(p=>mergeProgress(p,{answers:{q1:'Newest server'}}));interfere=false;}return server.put(payload);},getProgress:server.read});
 viewer.api.S.draft.q1='Local edit';server.change(p=>mergeProgress(p,{answers:{q1:'Other device'}}));await viewer.api.flush();interfere=true;await viewer.api.resolveConflict(false);
 assert.equal(server.read().answers.q1,'Newest server');assert.equal(viewer.api.S.draft.q1,'Local edit');assert.equal(JSON.parse(viewer.storage.get('workbook.sample.pending')).answers.q1,'Local edit');
});

test('semantic no-op saves keep revisions while fresh answer, grade history and help evidence each advance them',()=>{
 let p=mergeProgress(null,{answers:{q:'Fixture answer'},notes:{q:'Note'},ui:{picks:{q:{revealed:true,assisted:true}}},grades:{q:grade}});
 const before=JSON.parse(JSON.stringify(p));
 p=mergeProgress(p,{expectedRevision:p.revision,answers:{q:'Fixture answer'},notes:{q:'Note'},grades:{q:{...grade,source:'dashboard'}},ui:{picks:{q:{assisted:false,revealed:false}}}});
 assert.deepEqual(p,before);assert.equal(p.grades.q.source,'trainer');
 assert.throws(()=>mergeProgress(p,{expectedRevision:0,answers:{q:'Fixture answer'}}),e=>e.status===409);
 for(const change of [{answers:{q:'New answer'}},{ui:{picks:{q:{hintUsed:true}}}},{grades:{q:{grade:'got',at:'2026-10-09T12:00:00.000Z',source:'interview'}}}]){
  const revision=p.revision;p=mergeProgress(p,change);assert.equal(p.revision,revision+1);
 }
 assert.equal(p.history.q.length,2);assert.equal(p.ui.picks.q.revealed,true);
});

test('migrated replay keeps the original disk bytes and performs no atomic write; new evidence still writes',t=>{
 const dir=fixture(t),meta=store.createMinimalWorkbook(dir,{roleKey:'Fixture|Engineer',company:'Fixture',role:'Engineer'});
 store.appendChapterQuestions(dir,meta.id,{questions:[{id:'q1',markup:'@@q id=q1 company=both topic=Basics type=open diff=2 chapter=asked-in-interviews\nFixture question.\n@@answer\nReference.'}]});
 const file=path.join(store.wbDir(dir,meta.id),'progress.json');
 const legacy={version:1,answers:{q1:'Fixture answer'},grades:{q1:grade},history:{q1:[grade]},ui:{picks:{q1:{revealed:true}}}};
 const bytes=JSON.stringify(legacy,null,4)+'\n';fs.writeFileSync(file,bytes);
 const rename=fs.renameSync;let writes=0;t.mock.method(fs,'renameSync',(from,to)=>{if(to===file)writes++;return rename(from,to);});
 const replay=store.writeGrades(dir,meta.id,[{qid:'q1',...grade,source:'dashboard'}]);assert.equal(replay.progress.revision,0);assert.equal(replay.progress.grades.q1.source,'trainer');
 const saved=store.writeProgress(dir,meta.id,{expectedRevision:0,answers:{q1:'Fixture answer'},ui:{picks:{q1:{revealed:false}}}});assert.equal(saved.revision,0);assert.equal(writes,0);assert.equal(fs.readFileSync(file,'utf8'),bytes);
 const next=store.writeProgress(dir,meta.id,{expectedRevision:0,ui:{picks:{q1:{hintUsed:true}}}});assert.equal(next.revision,1);assert.equal(writes,1);assert.equal(next.ui.picks.q1.revealed,true);
 const after=fs.readFileSync(file,'utf8');store.writeProgress(dir,meta.id,{expectedRevision:1,ui:{picks:{q1:{hintUsed:true}}}});assert.equal(writes,1);assert.equal(fs.readFileSync(file,'utf8'),after);
});
