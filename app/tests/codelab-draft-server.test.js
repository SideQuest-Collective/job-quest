const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {withServer,post}=require('./helpers/server');
test('real Code Lab routes preserve revision drafts while merging solved state and reject stale snapshots',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'jq-code-draft-server-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 fs.mkdirSync(path.join(data,'problems'));
 fs.writeFileSync(path.join(data,'problems/problems.json'),JSON.stringify({categories:[],problems:[{id:'one',title:'One',starterCode:'def solve(x):\n    pass',functionName:'solve',testCases:[{input:{x:1},expected:1}]},{id:'two',title:'Two',starterCode:'def solve(x):\n    pass',functionName:'solve',testCases:[{input:{x:2},expected:2}]}]}));
 await withServer(data,async base=>{
  const patch=(id,code,revision)=>fetch(`${base}/api/problems/${id}/draft`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({code,expectedRevision:revision})});
  let r=await patch('one','draft A',0);assert.equal(r.status,200);assert.equal((await r.json()).revision,1);
  r=await patch('two','draft B',0);assert.equal(r.status,200);
  r=await fetch(`${base}/api/problems/progress`,post({solved:{one:{solvedAt:'2026-10-09T12:00:00Z',attempts:1}}}));assert.equal(r.status,200);
  let progress=(await r.json()).progress;
  assert.deepEqual(progress.savedCode,{one:'draft A',two:'draft B'});assert.deepEqual(progress.draftRevisions,{one:1,two:1});assert.ok(progress.solved.one);
  r=await fetch(`${base}/api/problems/progress`,post({solved:{},savedCode:{one:'stale'}}));assert.equal(r.status,409);
  r=await patch('one','device B',0);assert.equal(r.status,409);const conflict=await r.json();assert.equal(conflict.code,'draft A');assert.equal(conflict.revision,1);
  r=await patch('one','',1);assert.equal(r.status,200);
  progress=await(await fetch(`${base}/api/problems/progress`)).json();assert.equal(progress.savedCode.one,'');assert.equal(progress.savedCode.two,'draft B');assert.ok(progress.solved.one);
 });
});
