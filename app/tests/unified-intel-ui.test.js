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
function discoverHarness(){
 let cells=[],index=0,actions=empty(),fail=false;const requests=[];
 const ctx={useState(initial){const i=index++;if(!(i in cells))cells[i]=initial;return [cells[i],value=>cells[i]=typeof value==='function'?value(cells[i]):value];},useEffect(){},api:{post:async(url,value)=>{requests.push({url,value});if(fail)throw Error('Offline');}},Set};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function nativeRoleStatus'),source.indexOf('function DiscoverySourceCoverage')),ctx);
 const code=source.slice(source.indexOf('function Discover('),source.indexOf('  return <div className="discover-review">'));
 vm.runInContext(code+' return {update,undo,unseen,dismissed,lastAction,error};}',ctx);
 return {render(){index=0;return ctx.Discover({allRoles:[role],roleActions:actions,roleTracker:{},setRoleActions:value=>actions=value});},get actions(){return actions;},setActions(value){actions=value;},setFail(value){fail=value;},requests};
}
test('like saves through the real role action API contract and undo preserves unrelated decisions',async()=>{
 const h=discoverHarness();await h.render().update(role,'like');assert.equal(h.actions.saved.includes(key),true);assert.equal(h.render().unseen.length,0);
 h.setActions({...h.actions,saved:[...h.actions.saved,'Other|Role']});await h.render().undo();assert.deepEqual(h.actions.saved,['Other|Role']);assert.equal(h.render().unseen.length,1);assert.equal(h.requests[0].url,'/api/role-actions');
});
test('dismiss and restore reuse existing skipped state, and failed writes preserve the decision',async()=>{
 const h=discoverHarness();await h.render().update(role,'dismiss');assert.equal(h.render().dismissed.length,1);
 h.setFail(true);await h.render().update(role,'restore');assert.equal(h.render().dismissed.length,1);assert.match(h.render().error,/Offline/);
 h.setFail(false);await h.render().update(role,'restore');assert.equal(h.render().unseen.length,1);assert.equal(h.render().dismissed.length,0);
});

test('exact discovery launch distinguishes same-title listings by URL and location',()=>{
 const a={...role,url:'https://example.com/one',location:'New York'},b={...role,url:'https://example.com/two',location:'Remote'};
 assert.notEqual(context.discoveryRoleId(a),context.discoveryRoleId(b));
 assert.equal(context.discoveryRoleId({...a}),context.discoveryRoleId(a));
 assert.match(source,/This job is no longer in New/);
 assert.match(source,/Review other new jobs/);
});
