const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const store = require('../lib/learning/store');
const { registerLearningRoutes } = require('../lib/learning/routes');
const fixture = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-learning-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (dir, file, data) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), JSON.stringify(data)); };
const source = { kind: 'concept', path: 'resources/cheatsheets/maps.md', title: 'Maps', content: 'Map keys to values.' };
const answer = { id: 'attempt_one', kind: 'retrieval', minutes: 5, status: 'answered', response: 'A map uses keys to retrieve values.', sourceId: 'concept:resources/cheatsheets/maps.md', sourceHash: store.hash(source.content), goal: 'Explain maps', prompt: 'Explain a map', assisted: false, revealed: false };

test('source identity aligns with preparation; refresh needs the exact prior hash and preserves evidence', (t) => {
  const dir = fixture(t);
  let state = store.saveSource(dir, { revision: 0, source });
  assert.equal(state.sources[0].id, answer.sourceId);
  state = store.saveSession(dir, { revision: 1, session: answer });
  assert.equal(state.sessions[0].feedback.score, null);
  const replacement = { ...source, content: 'Updated map reference.' };
  assert.throws(() => store.saveSource(dir, { revision: 2, source: replacement }), /explicitly confirm/);
  assert.throws(() => store.saveSource(dir, { revision: 2, source: replacement, confirmRefresh: true, previousHash: 'stale' }), /explicitly confirm/);
  state = store.saveSource(dir, { revision: 2, source: replacement, confirmRefresh: true, previousHash: store.hash(source.content) });
  assert.equal(state.sessions[0].sourceSnapshot.content, source.content);
  assert.equal(state.sources[0].content, replacement.content);
  assert.throws(() => store.saveSession(dir, { revision: 3, session: { ...answer, response: 'Rewritten' } }), /preserved/);
});

test('stale saves and changed references cannot silently overwrite newer state', (t) => {
  const dir = fixture(t);
  store.saveSource(dir, { revision: 0, source });
  assert.throws(() => store.saveSource(dir, { revision: 0, source: {...source, title:'stale'} }), /out of date/);
  assert.throws(() => store.saveSession(dir, { revision: 1, session: {...answer, sourceHash:'old'} }), /reference changed/);
  assert.equal(store.load(dir).revision, 1);
  assert.equal(store.load(dir).sessions.length, 0);
});

test('drafts preserve help/reveal context; blank reading and background never count as answers', (t) => {
  const dir = fixture(t);
  store.saveSource(dir, { revision: 0, source });
  store.saveSession(dir, { revision: 1, session: {...answer, status:'draft', revealed:true, assisted:true} });
  const state = store.saveSession(dir, { revision: 2, session: answer });
  assert.equal(state.sessions[0].revealed, true);
  assert.equal(state.sessions[0].assisted, true);
  assert.throws(() => store.saveSession(dir, { revision: 3, session:{...answer,id:'empty_answer',response:''} }), /nonempty/);
  store.saveSource(dir, { revision: 3, source:{...source,kind:'resume'} });
  assert.throws(() => store.saveSession(dir, { revision: 4, session:{...answer,id:'resume_answer',sourceId:'resume:resources/cheatsheets/maps.md'} }), /Only concepts/);
});

test('saved draft identity cannot be changed while retaining its reference snapshot', (t) => {
  const dir=fixture(t);
  store.saveSource(dir,{revision:0,source});
  store.saveSession(dir,{revision:1,session:{...answer,status:'draft'}});
  for(const change of [{sourceId:'builtin:hashing'},{kind:'media'},{prompt:'Different question'},{goal:'Different goal'}]) {
    assert.throws(()=>store.saveSession(dir,{revision:2,session:{...answer,status:'draft',...change}}),/different activity/);
  }
  assert.equal(store.load(dir).sessions[0].sourceSnapshot.content,source.content);
  assert.equal(store.load(dir).revision,2);
});

test('linked reference attempts check the current hash and preserve their snapshot without copying library sources', (t) => {
  const dir=fixture(t);
  const linked={...source,id:answer.sourceId,sha256:store.hash(source.content),physicalPath:'/interview/topics/maps.md',resolvedPath:'/owned/maps.md'};
  let current=linked; const getLinkedSources=()=>({available:!!current,sources:current?[current]:[]});
  const input={...answer,sourceOrigin:'linked',status:'draft'};
  let state=store.saveSession(dir,{revision:0,session:input},{getLinkedSources});
  assert.equal(state.sources.length,0);assert.equal(state.sessions[0].sourceSnapshot.resolvedPath,'/owned/maps.md');
  current={...linked,content:'Changed source',sha256:store.hash('Changed source')};
  assert.throws(()=>store.saveSession(dir,{revision:1,session:{...input,id:'new_linked_attempt'}},{getLinkedSources}),/reference changed/);
  assert.throws(()=>store.saveSession(dir,{revision:1,session:{...input,sourceOrigin:'saved'}},{getLinkedSources}),/different reference origin/);
  current=null;
  state=store.saveSession(dir,{revision:1,session:{...input,status:'answered'}},{getLinkedSources});
  assert.equal(state.sessions[0].sourceSnapshot.content,source.content);assert.equal(state.sessions[0].status,'answered');
  assert.equal(state.sources.length,0);
});

test('existing local concepts import without mutating legacy data or replacing edits; stories stay distinct', (t) => {
  const dir = fixture(t);
  const legacy = { version:1,concepts:[{id:'old',title:'Map legacy',body:'Old body',source:{path:source.path}}, {id:'story',title:'A project',body:'Actual story',source:{path:'stories/project.md'}}] };
  write(dir,'concepts/library.json',legacy);
  store.saveSource(dir,{revision:0,source});
  const state=store.importExisting(dir,{revision:1});
  assert.equal(state.sources.length,2);
  assert.equal(state.sources[0].content,source.content);
  assert.equal(state.sources[1].kind,'story');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'concepts/library.json'))),legacy);
  assert.equal(state.sessions.length,0);
});

test('unfinished native code is prioritized and future/completed tasks excluded; reads preserve native data', (t) => {
  const dir = fixture(t);
  const progress = {savedCode:{map:'def solve(): pass'},solved:{done:true}};
  write(dir,'problems/progress.json',progress);
  write(dir,'tasks/2099-01-01.json',{tasks:[{text:'Future',link:{kind:'codelab',problemId:'future'}}]});
  write(dir,'tasks/2020-01-01.json',{date:'2020-01-01',tasks:[{text:'Done',completed:true,problemId:'done'},{text:'Earlier work',completed:false,link:{kind:'sysdesign',topicId:'queue'}}]});
  const result=store.quickChoices(dir,()=>({problems:[{id:'fresh',title:'New'},{id:'map',title:'Map'},{id:'done',title:'Done'}]}));
  assert.equal(result.choices[0].id,'code:map');
  assert.equal(result.choices[0].href,'/?problem=map');
  assert.equal(result.choices.length,3);
  assert.ok(result.choices.some(c=>c.href==='/?sd=queue'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'problems/progress.json'))),progress);
});

test('corrupt learning data is reported without replacing the original bytes', (t) => {
  const dir = fixture(t); write(dir,'learning/workspace.json',{version:3});
  const before = fs.readFileSync(path.join(dir,'learning/workspace.json'),'utf8');
  assert.throws(()=>store.saveSource(dir,{revision:0,source}),/unreadable/);
  assert.equal(fs.readFileSync(path.join(dir,'learning/workspace.json'),'utf8'),before);
});

test('API preserves state on 409 and validates media bookmarks', async (t) => {
  const dir = fixture(t); const app = express(); app.use(express.json()); registerLearningRoutes(app,{dataDir:dir,getLinkedSources:()=>({sources:[],warnings:[],available:false})});
  const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r)); t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/api/learning`;
  const post = (suffix,body)=>fetch(url+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(url)).status,200);
  let response = await post('/session',{revision:0,session:{...answer,kind:'media',sourceId:'media:mit-hashing',status:'draft',response:'',positionSeconds:90}});
  assert.equal(response.status,200); assert.equal((await response.json()).sessions[0].positionSeconds,90);
  assert.equal((await post('/sources',{revision:0,source})).status,409);
  assert.equal((await post('/session',{revision:1,session:{...answer,id:'invalid_position',kind:'media',sourceId:'media:mit-hashing',positionSeconds:-1}})).status,400);
  assert.equal(store.load(dir).sessions.length,1);
});
