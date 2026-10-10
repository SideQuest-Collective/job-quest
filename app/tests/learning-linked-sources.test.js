const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { readLinkedSources, linkedConflicts } = require('../lib/learning/linked-sources');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fixture = (t) => {const home=fs.mkdtempSync(path.join(os.tmpdir(),'jq-linked-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(path.join(home,'app'));fs.writeFileSync(path.join(home,'app/preparation.py'),'# synthetic');return home;};
const snapshot = (body = '# Design\n- Requirements\n- Entities\n- API\n') => ({ id:'concept:resources/cheatsheets/delivery.md',docId:'resources/cheatsheets/delivery.md',kind:'material',scope:'concept',title:'Delivery',path:'/shared/delivery.md',resolvedPath:'/owned/delivery.md',format:'markdown',content:body,sha256:sha(body) });

test('linked concepts use canonical preparation API and do not write plans or live selections', (t) => {
  const home=fixture(t);const calls=[];const s=snapshot();
  const run=(python,args,opts)=>{calls.push({python,args,opts});return {status:0,stdout:JSON.stringify(args[1]==='catalog'?{sources:[s],warnings:[]}:{schema:'interview-preparation/1',selected:[s],warnings:[]})};};
  const result=readLinkedSources({interviewHome:home,run});
  assert.equal(result.available,true);assert.equal(result.sources[0].id,s.id);
  assert.equal(result.sources[0].path,s.docId);assert.equal(result.sources[0].resolvedPath,s.resolvedPath);
  assert.equal(result.sources[0].linked,true);assert.equal(result.sources[0].readOnly,true);
  assert.equal(calls[1].args[0],'-c');assert.equal(calls[1].args[2],path.join(home,'app/preparation.py'));assert.equal(calls[1].args[3],s.id);
  assert.equal(calls[0].opts.env.INTERVIEW_HOME,home);assert.equal(calls[0].opts.env.PYTHONDONTWRITEBYTECODE,'1');
  assert.equal(calls.some(c=>c.args.includes('--output')),false);
});

test('changed shared files preserve identity but change hash and expose snapshot conflicts', (t) => {
  const home=fixture(t);const before=snapshot();const after=snapshot('# New\n- Constraints\n');
  const run=(python,args)=>({status:0,stdout:JSON.stringify(args[1]==='catalog'?{sources:[after]}:{schema:'interview-preparation/1',selected:[after]})});
  const linked=readLinkedSources({interviewHome:home,run});
  assert.equal(linked.sources[0].id,before.id);assert.notEqual(linked.sources[0].sha256,before.sha256);
  assert.deepEqual(linkedConflicts([before],linked.sources),[{id:before.id,savedHash:before.sha256,linkedHash:after.sha256,resolvedPath:after.resolvedPath}]);
  assert.equal(before.content,snapshot().content);
});

test('invalid snapshots and failed subprocesses never produce usable references', (t) => {
  const home=fixture(t),s=snapshot();
  const wrongHash=(python,args)=>({status:0,stdout:JSON.stringify(args[1]==='catalog'?{sources:[s]}:{schema:'interview-preparation/1',selected:[{...s,sha256:'wrong'}]})});
  const corrupted=readLinkedSources({interviewHome:home,run:wrongHash});
  assert.equal(corrupted.available,false);assert.deepEqual(corrupted.sources,[]);assert.match(corrupted.warnings[0],/hash/);
  const failed=readLinkedSources({interviewHome:home,run:()=>({status:1,stderr:'private details'})});
  assert.deepEqual(failed.sources,[]);assert.equal(failed.warnings.join('').includes('private details'),false);
});

test('missing interview installation is a nonfatal unavailable state', (t) => {
  const home=fixture(t);fs.unlinkSync(path.join(home,'app/preparation.py'));
  const result=readLinkedSources({interviewHome:home,run:()=>{throw Error('must not run');}});
  assert.equal(result.available,false);assert.deepEqual(result.sources,[]);
});

const interviewApp = process.env.INTERVIEW_APP_SOURCE;
test('installed preparation reads the same owned file through a symlink without changing accepted snapshots', {skip:!interviewApp}, (t) => {
  const home=fixture(t);
  for(const name of ['preparation.py','context.py']) fs.copyFileSync(path.join(interviewApp,name),path.join(home,'app',name));
  const owned=path.join(home,'owned');fs.mkdirSync(owned);fs.mkdirSync(path.join(home,'cheatsheets'));
  fs.symlinkSync(owned,path.join(home,'cheatsheets','topics'));
  const file=path.join(owned,'delivery-framework.md');const initial='# Delivery\n- Requirements\n- Core entities\n- API\n';fs.writeFileSync(file,initial);
  const before=readLinkedSources({interviewHome:home});
  assert.equal(before.available,true,JSON.stringify(before.warnings));assert.equal(before.sources[0].id,'concept:resources/cheatsheets/delivery-framework.md');
  assert.equal(before.sources[0].resolvedPath,fs.realpathSync(file));assert.equal(before.sources[0].sha256,sha(initial));
  fs.writeFileSync(file,'# Revised\n- Clarify constraints\n- Core entities\n');
  const after=readLinkedSources({interviewHome:home});assert.equal(after.sources[0].id,before.sources[0].id);assert.notEqual(after.sources[0].sha256,before.sources[0].sha256);
  assert.equal(before.sources[0].content,initial);assert.equal(linkedConflicts(before.sources,after.sources).length,1);
  assert.equal(fs.existsSync(path.join(home,'live')),false);assert.equal(fs.existsSync(path.join(home,'config.json')),false);
});

test('installed capture preserves selections and publishes explicit coming-next provenance without audio or HUD', {skip:!interviewApp}, () => {
  const output=execFileSync('python3',[path.join(__dirname,'helpers','learning-preparation-contract.py'),interviewApp],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:20000});
  const result=JSON.parse(output);assert.equal(result.selectedSnapshotVerified,true);assert.equal(result.reselectionPreservesWork,true);
  assert.equal(result.preparationEventVerified,true);assert.equal(result.comingNextPublicationVerified,true);assert.equal(result.automaticCoachingGenerationVerified,false);
});
