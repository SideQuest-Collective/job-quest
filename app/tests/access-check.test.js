const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {revision}=require('../lib/opportunities/routes');
const {groupAccounts,validateResults,createAccessChecks,buildPrompt}=require('../lib/opportunities/access-check');
const accounts=[{id:'mail',kind:'gmail',label:'me@example.com',sourceName:'mail-report'},{id:'notifications',kind:'linkedin_email',label:'ME@example.com',sourceName:'old-notifications'},{id:'linkedin',kind:'linkedin',label:'https://www.linkedin.com/in/test/'}];
const groups=groupAccounts(accounts.slice(0,2));
const result=(status='verified',extra={})=>JSON.stringify({results:[{accountId:'mail',status,identity:'me@example.com',detail:'Mailbox identity and list access checked.',evidence:[{toolId:'profile',kind:'identity'},{toolId:'list',kind:'read'}],...extra}]});
const evidence=[{id:'profile',name:'gmail/get_profile',ok:true,resultText:'{"email":"me@example.com"}'},{id:'list',name:'gmail/list_messages',ok:true,resultText:'{"messages":[]}'}];
function fixture(t,runAgent){const root=fs.mkdtempSync(path.join(os.tmpdir(),'access-check-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const accountFile=path.join(root,'opportunity-accounts.json');fs.writeFileSync(accountFile,JSON.stringify({accounts}));const control=createAccessChecks({dataDir:root,runAgent});const input=()=>({revision:revision(JSON.parse(fs.readFileSync(accountFile))),accountIds:['mail','notifications']});return {root,accountFile,control,input};}
test('one mailbox groups notification aliases and prompt asks only minimal reads',()=>{assert.equal(groups.length,1);assert.deepEqual(groups[0].accountIds,['mail','notifications']);const prompt=buildPrompt(groups);assert.match(prompt,/Do not read message bodies/);assert.match(prompt,/do not check it as a second account/);assert.equal((prompt.match(/"accountId"/g)||[]).length,2);});
test('verified requires real identity and successful read evidence; model assertion alone cannot pass',()=>{assert.deepEqual(validateResults(result(),groups,evidence).map(r=>r.status),['verified','verified']);for(const proof of [[],[evidence[0]],evidence.map(e=>({...e,ok:false})),[{...evidence[0],resultText:'other@example.com'},evidence[1]]])assert.ok(validateResults(result(),groups,proof).every(r=>r.status==='unverified'));assert.equal(validateResults(result('verified',{identity:'other@example.com'}),groups,evidence)[0].status,'unverified');});
test('tool discovery and public web search are not inbox-read evidence',()=>{for(const name of ['web/search','gmail/search_tools','shell/command_execution']){assert.equal(validateResults(result(),groups,[evidence[0],{...evidence[1],name}])[0].status,'unverified');}});
test('malformed or unrelated model results fail closed',()=>{assert.throws(()=>validateResults('not json',groups),/unreadable/);assert.throws(()=>validateResults(result('verified',{accountId:'unknown'}),groups),/invalid/);assert.throws(()=>validateResults('{"results":[]}',groups),/each account/);});
test('direct check fans one mailbox result to aliases, preserves other data and never exposes private evidence',async t=>{let calls=0;const f=fixture(t,async()=>{calls++;return {text:result(),toolEvidence:[...evidence,{id:'other',ok:true,resultText:'PRIVATE_BODY'}]};});f.control.start(f.input());await f.control.wait();assert.equal(calls,1);const state=f.control.status().check;assert.equal(state.status,'completed');assert.equal(state.saved,true);assert.equal(JSON.stringify(state).includes('PRIVATE_BODY'),false);const saved=JSON.parse(fs.readFileSync(f.accountFile));assert.equal(saved.accounts[0].accessStatus,'verified');assert.equal(saved.accounts[1].accessStatus,'verified');assert.equal(saved.accounts[1].sourceName,'old-notifications');assert.deepEqual(saved.accounts[2],accounts[2]);assert.equal(fs.statSync(f.accountFile).mode&0o777,0o600);});
test('concurrent checks and stale request revisions are rejected',async t=>{let finish;const f=fixture(t,()=>new Promise(r=>finish=r));assert.throws(()=>f.control.start({...f.input(),revision:'old'}),/changed/);f.control.start(f.input());await Promise.resolve();assert.throws(()=>f.control.start(f.input()),/already running/);finish({text:result('connection_unavailable'),toolEvidence:[]});await f.control.wait();});
test('account edits while checking are preserved and result is marked unsaved',async t=>{let finish;const f=fixture(t,()=>new Promise(r=>finish=r));f.control.start(f.input());await Promise.resolve();fs.writeFileSync(f.accountFile,JSON.stringify({accounts:accounts.map(a=>({...a,label:'edited'}))}));finish({text:result(),toolEvidence:evidence});await f.control.wait();assert.equal(f.control.status().check.saved,false);assert.equal(JSON.parse(fs.readFileSync(f.accountFile)).accounts[0].label,'edited');});
test('runtime failure and restart do not claim access or overwrite account history',async t=>{const f=fixture(t,async()=>{throw Error('SECRET raw output');});const before=fs.readFileSync(f.accountFile,'utf8');f.control.start(f.input());await f.control.wait();assert.equal(f.control.status().check.status,'failed');assert.doesNotMatch(f.control.status().check.error,/SECRET/);assert.equal(fs.readFileSync(f.accountFile,'utf8'),before);const file=path.join(f.root,'logs/account-access-check.json');fs.writeFileSync(file,JSON.stringify({status:'running',accountIds:['mail']}));assert.equal(createAccessChecks({dataDir:f.root}).status().check.status,'interrupted');});

test('tool names can match actual traces when CLI item IDs differ from model call IDs',()=>{
 const text=result('verified',{evidence:[{toolName:'gmail/get_profile',kind:'identity'},{toolName:'gmail/list_messages',kind:'read'}]});
 assert.equal(validateResults(text,groups,evidence.map(e=>({...e,id:'item_'+e.id})))[0].status,'verified');
});
test('similar email addresses cannot prove the selected mailbox identity',()=>{
 assert.equal(validateResults(result(),groups,[{...evidence[0],resultText:'{"email":"otherme@example.com"}'},evidence[1]])[0].status,'unverified');
});

test('read evidence must be a distinct call on the same connector as identity',()=>{
 assert.equal(validateResults(result(),groups,[evidence[0],{...evidence[1],name:'outlook/list_messages'}])[0].status,'unverified');
 assert.equal(validateResults(result('verified',{evidence:[{toolId:'profile',kind:'identity'},{toolId:'profile',kind:'read'}]}),groups,[{...evidence[0],name:'outlook/read_profile'}])[0].status,'unverified');
});
test('different mailboxes get separate executions so one inbox read cannot verify another',async t=>{
 let calls=0;const f=fixture(t,async({prompt})=>{calls++;const id=prompt.includes('"accountId":"mail"')?'mail':'second';return {text:JSON.stringify({results:[{accountId:id,status:'connection_unavailable',detail:'Connect the mailbox.'}]}),toolEvidence:[]};});
 fs.writeFileSync(f.accountFile,JSON.stringify({accounts:[accounts[0],{id:'second',kind:'gmail',label:'second@example.com'}]}));
 f.control.start({...f.input(),accountIds:['mail','second']});await f.control.wait();assert.equal(calls,2);assert.equal(f.control.status().check.results.length,2);
});

test('later runtime failure preserves earlier verified results and failed account history',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;if(calls===1)return {text:result(),toolEvidence:evidence};throw Error('SECRET failed connector output');});
 const priorLinkedIn={...accounts[2],accessStatus:'verified',accessCheckedAt:'2026-10-01T10:00:00Z',accessDetail:'Previous verified history.'};
 fs.writeFileSync(f.accountFile,JSON.stringify({accounts:[accounts[0],accounts[1],priorLinkedIn]}));
 f.control.start({...f.input(),accountIds:['mail','notifications','linkedin']});await f.control.wait();
 const state=f.control.status().check,saved=JSON.parse(fs.readFileSync(f.accountFile));
 assert.equal(state.status,'completed');assert.equal(state.saved,true);assert.equal(calls,2);
 assert.deepEqual(state.results.map(r=>r.status),['verified','verified','unverified']);
 assert.equal(saved.accounts[0].accessStatus,'verified');assert.equal(saved.accounts[1].accessStatus,'verified');assert.deepEqual(saved.accounts[2],priorLinkedIn);
 assert.match(state.results[2].detail,/Previous saved access status was kept/);assert.doesNotMatch(JSON.stringify(state),/SECRET/);
 assert.match(state.error,/Some accounts could not be checked/);
});

test('expired shared deadline keeps completed results and avoids starting remaining accounts',async t=>{
 let calls=0;const f=fixture(t);
 const control=createAccessChecks({dataDir:f.root,timeoutMs:10,runAgent:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,20));return {text:result(),toolEvidence:evidence};}});
 control.start({...f.input(),accountIds:['mail','linkedin']});await control.wait();
 assert.equal(calls,1);assert.equal(control.status().check.status,'completed');assert.equal(control.status().check.saved,true);
 assert.deepEqual(control.status().check.results.map(r=>r.status),['verified','unverified']);assert.match(control.status().check.results[1].detail,/timed out/);
 const saved=JSON.parse(fs.readFileSync(f.accountFile));assert.equal(saved.accounts[0].accessStatus,'verified');assert.deepEqual(saved.accounts[2],accounts[2]);
});

test('all runtime failures return unverified results without replacing saved history',async t=>{
 const f=fixture(t,async()=>{throw Object.assign(Error('The account check timed out.'),{code:'ACCESS_TIMEOUT'});});
 const before=fs.readFileSync(f.accountFile,'utf8');f.control.start({...f.input(),accountIds:['mail','notifications','linkedin']});await f.control.wait();
 assert.equal(f.control.status().check.status,'failed');assert.equal(f.control.status().check.saved,false);
 assert.equal(f.control.status().check.results.length,3);assert.ok(f.control.status().check.results.every(r=>r.status==='unverified'));
 assert.equal(fs.readFileSync(f.accountFile,'utf8'),before);
});

test('partial results retain account revision protection',async t=>{
 let calls=0,finish;const f=fixture(t,async()=>{calls++;if(calls===1)return {text:result(),toolEvidence:evidence};return new Promise(resolve=>finish=resolve);});
 f.control.start({...f.input(),accountIds:['mail','linkedin']});while(!finish)await new Promise(resolve=>setImmediate(resolve));
 const edited={accounts:accounts.map(a=>a.id==='mail'?{...a,label:'changed@example.com'}:a)};fs.writeFileSync(f.accountFile,JSON.stringify(edited));
 finish({text:'invalid response',toolEvidence:[]});await f.control.wait();
 assert.equal(f.control.status().check.saved,false);assert.deepEqual(JSON.parse(fs.readFileSync(f.accountFile)),edited);
});

 test('real Codex app dotted tool names match model-facing names and provider boundaries stay distinct',()=>{
 const text=result('verified',{evidence:[{toolName:'mcp__codex_apps__gmail_get_profile',kind:'identity'},{toolName:'mcp__codex_apps__gmail_search_email_ids',kind:'read'}]});
 const proof=[{...evidence[0],name:'codex_apps/gmail.get_profile'},{...evidence[1],name:'codex_apps/gmail.search_email_ids'}];
 assert.equal(validateResults(text,groups,proof)[0].status,'verified');
 const crossed=result('verified',{evidence:[{toolId:'profile',kind:'identity'},{toolId:'list',kind:'read'}]});
 assert.equal(validateResults(crossed,groups,[proof[0],{...proof[1],name:'codex_apps/outlook.search_email_ids'}])[0].status,'unverified');
 });
