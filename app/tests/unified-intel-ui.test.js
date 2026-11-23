const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const context={};vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function nativeRoleStatus'),source.indexOf('function DiscoverySourceCoverage')),context);
vm.runInContext(source.slice(source.indexOf('function canonicalPage'),source.indexOf('function readPageHash')),context);
const role={company:'Acme',role:'Engineer'},key='Acme|Engineer',empty=()=>({saved:[],skipped:[],applied:[]});
test('legacy outreach and role links keep distinct destinations within Intel',()=>{
 assert.equal(context.canonicalPage('opportunities'),'intel-outreach');assert.equal(context.canonicalPage('intel'),'intel-roles');assert.equal(context.canonicalPage('discover'),'discover');assert.equal(context.canonicalPage('setup-accounts'),'setup-accounts');
});
test('undecided jobs and My roles do not duplicate saved/dismissed/applied/tracked decisions',()=>{
 assert.equal(context.undecidedRole(role,empty(),{}),true);assert.equal(context.myRoleMatches(role,empty(),{}),false);
 for(const field of ['saved','skipped','applied']){const actions={...empty(),[field]:[key]};assert.equal(context.undecidedRole(role,actions,{}),false);assert.equal(context.myRoleMatches(role,actions,{}),field!=='skipped');}
 assert.equal(context.undecidedRole(role,empty(),{[key]:{notes:'Existing research',stage:'discovered'}}),false);
});
test('role filters give applications/interviews a shared in-progress home and distinguish closed outcomes',()=>{
 for(const stage of ['researching','applied','phone-screen','onsite'])assert.equal(context.myRoleMatches(role,empty(),{[key]:{stage}},'progress'),true);
 for(const stage of ['offer','rejected']){assert.equal(context.myRoleMatches(role,empty(),{[key]:{stage}},'closed'),true);assert.equal(context.myRoleMatches(role,empty(),{[key]:{stage}},'progress'),false);}
 assert.equal(context.myRoleMatches(role,{...empty(),saved:[key]},{},'saved'),true);
 assert.equal(context.myRoleMatches(role,{...empty(),applied:[key]},{[key]:{stage:'discovered'}},'progress'),true);
});
// Discover runs against the real per-role event handler (lib/jobs/role-state) on a temp data dir,
// with the response shaped like POST /api/role-actions/event.
const os=require('node:os'),roleState=require('../lib/jobs/role-state'),roleHistoryLib=require('../lib/jobs/role-history');
const identityContext={window:{},URL};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/jobs/role-identity.js'),'utf8'),identityContext);
const harnessDirs=new Set();test.after(()=>harnessDirs.forEach(dir=>fs.rmSync(dir,{recursive:true,force:true})));
function discoverHarness({roles=[role],shared=false,dir=fs.mkdtempSync(path.join(os.tmpdir(),'jq-discover-ui-'))}={}){
 harnessDirs.add(dir);
 const instances=new Map(),requests=[];let cells,index=0,fail=false,decision={busy:false};
 let actions=roleState.readRoleActions(dir),tracker={},history=roleHistoryLib.summarize(roleState.ensureRoleHistory(dir,actions,tracker,new Date().toISOString()));
 const respond=result=>({actions:roleState.actionsWithApplications(result.actions,result.tracker),undone:roleHistoryLib.publicEvent(result.undone),trackerChange:result.event?{key:result.event.key,entry:result.tracker[result.event.key]??null}:null,history:roleHistoryLib.summarize(result.history)});
 const api={post:async(url,value)=>{requests.push({url,value});if(fail)throw Error('Offline');if(url!=='/api/role-actions/event')throw Error('unexpected '+url);const result=roleState.applyRoleEvent(dir,value,tracker,new Date().toISOString());tracker=result.tracker;return respond(result);},
  get:async url=>{requests.push({url});if(url!=='/api/role-history')throw Error('unexpected '+url);return roleHistoryLib.summarize(roleHistoryLib.readHistory(dir));}};
 const ctx={useState(initial){const i=index++,stateCells=cells;if(!(i in stateCells))stateCells[i]=initial;return [stateCells[i],value=>stateCells[i]=typeof value==='function'?value(stateCells[i]):value];},useEffect(){},api,Set,window:identityContext.window};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function nativeRoleStatus'),source.indexOf('function DiscoverySourceCoverage')),ctx);
 const code=source.slice(source.indexOf('function Discover('),source.indexOf('  return <div className="discover-review">'));
 vm.runInContext(code+' return {update,undo,unseen,dismissed,undoTarget,error,selected,view,busy,setSelectedKey,setView};}',ctx);
 const flush=()=>new Promise(setImmediate);
 return {dir,render(name='card',{listMode=false}={}){if(!instances.has(name))instances.set(name,[]);cells=instances.get(name);index=0;return ctx.Discover({allRoles:roles,roleActions:actions,roleTracker:tracker,roleHistory:history,setRoleActions:value=>actions=value,setRoleTracker:fn=>tracker=typeof fn==='function'?fn(tracker):fn,setRoleHistory:value=>history=value,listMode,decisionState:shared?{...decision,setBusy:value=>decision.busy=value}:undefined});},
  get actions(){return actions;},get history(){return history;},
  // Another tab or Intel changed role state on the server; the next refresh brings it in.
  setActions(value){roleState.writeRoleState(dir,value,tracker);actions=roleState.actionsWithApplications(value,tracker);},
  setFail(value){fail=value;},requests,flush};
}
test('like saves through the per-role event API and undo preserves unrelated decisions',async()=>{
 const h=discoverHarness();await h.render().update(role,'like');assert.equal(h.actions.saved.includes(key),true);assert.equal(h.render().unseen.length,0);
 assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0])),{url:'/api/role-actions/event',value:{action:'save',key,keys:[key],url:null}});
 assert.equal(h.render().undoTarget.action,'save');
 h.setActions({...h.actions,saved:[...h.actions.saved,'Other|Role']});await h.render().undo();assert.deepEqual(Array.from(h.actions.saved),['Other|Role']);assert.equal(h.render().unseen.length,1);
 assert.equal(h.requests.some(r=>r.url==='/api/role-actions'),false,'never a full-state write');
});
test('dismiss and restore go through the ledger, and failed writes preserve the decision',async()=>{
 const h=discoverHarness();await h.render().update(role,'dismiss');assert.equal(h.render().dismissed.length,1);assert.equal(h.render().unseen.length,0);
 h.setFail(true);await h.render().update(h.render().dismissed[0],'restore');assert.equal(h.render().dismissed.length,1);assert.match(h.render().error,/Offline/);
 h.setFail(false);await h.render().update(h.render().dismissed[0],'restore');assert.equal(h.render().unseen.length,1);assert.equal(h.render().dismissed.length,0);
 assert.equal(h.history.handled.some(entry=>entry.key===key),false,'the retired skip no longer hides the role');
 assert.equal(h.render().undoTarget,null,'the restored skip is not offered for undo');
});
test('a role handled only in the ledger stays out of New even after it leaves Saved',async()=>{
 const h=discoverHarness();await h.render().update(role,'like');
 h.setActions({saved:[],skipped:[],applied:[]});
 assert.equal(h.render().unseen.length,0,'removed from Saved elsewhere, still handled');
});
test('undo target comes from the server and survives a reload',async()=>{
 const first=discoverHarness();await first.render().update(role,'dismiss');
 const reloaded=discoverHarness({dir:first.dir});
 assert.equal(reloaded.render().undoTarget.key,key);assert.equal(reloaded.render().undoTarget.action,'skip');
 await reloaded.render().undo();assert.equal(reloaded.render().unseen.length,1);assert.equal(reloaded.render().undoTarget,null);
});

test('exact discovery launch distinguishes same-title listings by URL and location',()=>{
 const a={...role,url:'https://example.com/one',location:'New York'},b={...role,url:'https://example.com/two',location:'Remote'};
 assert.notEqual(context.discoveryRoleId(a),context.discoveryRoleId(b));
 assert.equal(context.discoveryRoleId({...a}),context.discoveryRoleId(a));
 assert.match(source,/This job is no longer in New/);
 assert.match(source,/Review other new jobs/);
});

test('Intel Discover is a distinct valid hash while legacy hashes retain their destinations',()=>{
 const routing={window:{location:{hash:'#intel-discover'}},Set};vm.createContext(routing);
 vm.runInContext(source.slice(source.indexOf('const PAGE_IDS ='),source.indexOf('function usePageRouting')),routing);
 assert.equal(routing.readPageHash(),'intel-discover');
 for(const [hash,page] of [['#discover','discover'],['#intel','intel-roles'],['#opportunities','intel-outreach'],['#unknown',null]]){routing.window.location.hash=hash;assert.equal(routing.readPageHash(),page);}
});

test('list selects exact same-title listing and falls back when another view removes it',()=>{
 const a={...role,url:'https://example.com/one',location:'New York'},b={...role,url:'https://example.com/two',location:'Remote'},other={company:'Other',role:'Designer'};
 const h=discoverHarness({roles:[a,b,other],shared:true});
 h.render('list',{listMode:true}).setSelectedKey(context.discoveryRoleId(b));
 assert.equal(h.render('list',{listMode:true}).selected.url,b.url);
 h.setActions({...empty(),saved:[key]});
 assert.equal(h.render('list',{listMode:true}).selected.company,'Other');
 h.setActions({...empty(),saved:[key,'Other|Designer']});
 assert.equal(h.render('list',{listMode:true}).selected,undefined);
});

test('card and list share one ledger undo that walks back several actions and preserves unrelated choices',async()=>{
 const other={company:'Other',role:'Designer'},third='Third|Architect';
 const h=discoverHarness({roles:[role,other],shared:true});
 await h.render('card').update(role,'like');
 assert.equal(h.render('list',{listMode:true}).undoTarget.key,key);
 assert.equal(h.render('list',{listMode:true}).unseen.length,1);
 await h.render('list',{listMode:true}).update(other,'dismiss');
 assert.equal(h.render('card').undoTarget.key,'Other|Designer');
 h.setActions({...h.actions,applied:[third]});
 await h.render('card').undo();
 assert.deepEqual(Array.from(h.actions.saved),[key]);assert.deepEqual(Array.from(h.actions.skipped),[]);assert.deepEqual(Array.from(h.actions.applied),[third]);
 assert.equal(h.render('card').selected,other,'the restored role is shown again');
 assert.equal(h.render('list',{listMode:true}).undoTarget.key,key,'the next undo walks back the earlier save');
 await h.render('list',{listMode:true}).undo();
 assert.deepEqual(Array.from(h.actions.saved),[]);assert.deepEqual(Array.from(h.actions.applied),[third]);
 assert.equal(h.render('card').unseen.length,2);assert.equal(h.render('card').undoTarget,null);
});

test('failed cross-view choice and undo preserve saved state and the last successful undo',async()=>{
 const other={company:'Other',role:'Designer'},h=discoverHarness({roles:[role,other],shared:true});
 await h.render('list',{listMode:true}).update(role,'like');
 h.setFail(true);await h.render('card').update(other,'dismiss');
 assert.deepEqual(Array.from(h.actions.saved),[key]);assert.deepEqual(Array.from(h.actions.skipped),[]);
 assert.equal(h.render('card').undoTarget.key,key);assert.match(h.render('card').error,/Offline/);
 await h.render('list',{listMode:true}).undo();
 assert.deepEqual(Array.from(h.actions.saved),[key]);assert.equal(h.render('card').undoTarget.key,key);assert.match(h.render('list',{listMode:true}).error,/Offline/);
 h.setFail(false);await h.render('card').undo();
 assert.equal(h.render('list',{listMode:true}).unseen.length,2);assert.equal(h.render('list',{listMode:true}).undoTarget,null);
});

test('pending decision blocks a second write from the other Discover view',async()=>{
 const other={company:'Other',role:'Designer'},h=discoverHarness({roles:[role,other],shared:true});
 const first=h.render('list',{listMode:true}).update(role,'like');
 assert.equal(h.render('card').busy,true);
 await h.render('card').update(other,'dismiss');await first;
 assert.equal(h.requests.length,1);assert.deepEqual(Array.from(h.actions.saved),[key]);assert.deepEqual(Array.from(h.actions.skipped),[]);
 assert.equal(h.render('list',{listMode:true}).busy,false);
});

test('App, dashboard and both Discover views use the identity- and ledger-based New list',()=>{
 assert.match(source,/const newRoles = React\.useMemo\(\(\) => unseenNativeRoles\(allRoles, roleActions, roleTracker, roleHistory\)/);
 assert.match(source,/<Dashboard [^>]*undecidedRoles=\{newRoles\}/);
 assert.match(source,/const unseen=unseenNativeRoles\(allRoles,roleActions,roleTracker,roleHistory\);/);
 assert.equal((source.match(/<Discover [^>]*roleHistory=\{roleHistory\}/g)||[]).length,2);
});
