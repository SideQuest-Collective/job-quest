const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.resolve(__dirname,'../public/index.html'),'utf8');
const controllerSource=html.slice(html.indexOf('  function createCodeDraftController('),html.indexOf('  // END CODE DRAFT CONTROLLER'));
const createController=new Function(controllerSource+';return createCodeDraftController;')();
function setup({request=async(id,b)=>({code:b.code,revision:b.expectedRevision+1}),local={}}={}){
 const timers=new Map(),storage={...local};let seq=0,state={};
 const model=createController({request,changed:s=>{state=s;},readLocal:id=>storage[id],writeLocal:(id,s)=>{storage[id]=JSON.parse(JSON.stringify(s));},schedule:fn=>{timers.set(++seq,fn);return seq;},cancel:id=>timers.delete(id)});
 return {model,timers,storage,get state(){return state;}};
}
test('editing multiple problems uses separate queues and persists empty code',async()=>{
 const writes=[];const h=setup({request:async(id,b)=>{writes.push({id,...b});return {code:b.code,revision:b.expectedRevision+1};}});
 h.model.hydrate('one','starter',0);h.model.hydrate('two','starter',0);
 h.model.edit('one','A');h.model.edit('two','');assert.equal(h.timers.size,2);
 await Promise.all([h.model.flush('one'),h.model.flush('two')]);
 assert.deepEqual(writes,[{id:'one',code:'A',expectedRevision:0},{id:'two',code:'',expectedRevision:0}]);
 assert.equal(h.storage.two.code,'');assert.equal(h.storage.two.dirty,false);
});
test('edits made while saving wait for the first revision and do not revert editor text',async()=>{
 const pending=[],writes=[];const h=setup({request:(id,b)=>{writes.push(b);return new Promise(resolve=>pending.push(()=>resolve({code:b.code,revision:b.expectedRevision+1})));}});
 h.model.hydrate('one','',0);h.model.edit('one','first');const saving=h.model.flush('one');
 h.model.edit('one','latest');const alsoSaving=h.model.flush('one');assert.equal(writes.length,1);
 pending.shift()();await new Promise(setImmediate);assert.deepEqual(writes[1],{code:'latest',expectedRevision:1});
 assert.equal(h.state.one.code,'latest');pending.shift()();await Promise.all([saving,alsoSaving]);
 assert.equal(writes.length,2);assert.equal(h.state.one.revision,2);assert.equal(h.state.one.dirty,false);
});
test('conflict preserves local code, blocks automatic writes, and requires explicit choice',async()=>{
 let calls=0;const h=setup({request:async(id,b)=>{calls++;if(calls===1)throw Object.assign(new Error('Conflict'),{status:409,current:{code:'remote',revision:3}});return {code:b.code,revision:b.expectedRevision+1};}});
 h.model.hydrate('one','',0);h.model.edit('one','mine');assert.equal(await h.model.flush('one'),false);
 assert.equal(h.state.one.code,'mine');assert.equal(h.state.one.conflict.code,'remote');
 h.model.edit('one','my revised version');assert.equal(h.timers.size,0);await h.model.flush('one');assert.equal(calls,1);
 await h.model.resolve('one',false);assert.equal(calls,2);assert.equal(h.state.one.revision,4);assert.equal(h.state.one.code,'my revised version');
});
test('using authoritative saved code preserves an intentional empty remote value',async()=>{
 const h=setup({local:{one:{code:'local',revision:1,dirty:true}}});h.model.hydrate('one','',2);
 assert.ok(h.state.one.conflict);await h.model.resolve('one',true);
 assert.equal(h.state.one.code,'');assert.equal(h.state.one.revision,2);assert.equal(h.state.one.dirty,false);assert.equal(h.timers.size,0);
});
test('reload restores dirty drafts with original revision and detects another device edit',()=>{
 const h=setup({local:{one:{code:'offline',revision:4,dirty:true},two:{code:'pending',revision:2,dirty:true}}});
 h.model.hydrate('one','remote',5);h.model.hydrate('two','old',2);
 assert.equal(h.state.one.code,'offline');assert.deepEqual(h.state.one.conflict,{code:'remote',revision:5});
 assert.equal(h.state.two.code,'pending');assert.equal(h.timers.size,1);
});
test('network failure keeps browser draft and retry uses the same expected revision',async()=>{
 const writes=[];const h=setup({request:async(id,b)=>{writes.push(b);if(writes.length===1)throw new Error('Offline');return {code:b.code,revision:1};}});
 h.model.hydrate('one','',0);h.model.edit('one','answer');await h.model.flush('one');
 assert.equal(h.storage.one.dirty,true);assert.equal(h.state.one.error,'Offline');
 await h.model.flush('one');assert.equal(writes[1].expectedRevision,0);assert.equal(h.storage.one.dirty,false);
});
test('Code Lab uses current navigation requests and per-problem saves, not snapshot/debounce writes',()=>{
 const source=html.slice(html.indexOf('function CodeLab('),html.indexOf('\nfunction CMEditor('));
 assert.doesNotMatch(source,/_codeSaveTimer|api\.post\('\/api\/problems\/progress', updated\)/);
 assert.match(source,/initialProblemRef\?\.current;if\(id&&problems\.problems/);
 assert.match(source,/Object\.hasOwn\(progress\.savedCode\|\|\{\},problem\.id\)/);
 assert.match(source,/api\.post\('\/api\/problems\/progress',\{solved:/);
 assert.match(source,/key=\{`\$\{selectedId\}:\$\{editorEpoch\}`\}/);
});
test('Trainer completion clears only its unchanged submitted draft and preserves newer edits',()=>{
 const source=html.slice(html.indexOf('function Trainer('),html.indexOf('\nfunction cleanProblemDescription'));
 const expression=source.match(/const cleared=([^;]+);/)[1];
 const cleared=new Function('completedAttempt','q','next','local',`return ${expression};`);
 const a={id:'attempt',questionId:'q1',answer:'submitted'},q={id:'q1',evaluation:{attemptId:'attempt'},draft:''};
 assert.equal(cleared(a,q,{q1:'submitted'},null),true);
 assert.equal(cleared(a,q,{q1:'newer'},null),false);
 assert.equal(cleared(a,q,{q1:'submitted'},'new pending'),false);
 assert.equal(cleared({...a,superseded:true},q,{q1:'submitted'},null),false);
});
