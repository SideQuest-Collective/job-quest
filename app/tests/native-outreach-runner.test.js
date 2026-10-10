const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const source = process.env.JQ_TEST_RUNNER || path.resolve(__dirname, '../../skill/bin/run-daily-intel.sh');

function fixture(t, {existing=false, candidate=true, reject=false, runtime='codex', external=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jq-outreach-runner-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['skill/bin','lib','data/intel','references']) fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.copyFileSync(source,path.join(root,'skill/bin/run-daily-intel.sh'));
  fs.mkdirSync(path.join(root,'app/lib/intel-control'),{recursive:true});
  fs.copyFileSync(path.resolve(__dirname,'../lib/intel-control/lock.js'),path.join(root,'app/lib/intel-control/lock.js'));
  fs.writeFileSync(path.join(root,'data/profile.json'),JSON.stringify({name:'Fixture'}));
  if(external) fs.writeFileSync(path.join(root,'data/local-setup.json'),JSON.stringify({schedule:'external'}));
  fs.writeFileSync(path.join(root,'data/opportunity-accounts.json'),JSON.stringify({accounts:[{id:'fixture',kind:'gmail',label:'fixture@example.test'}]}));
  fs.writeFileSync(path.join(root,'references/intel-agent-template.md'),'Fixture template');
  if(existing) fs.writeFileSync(path.join(root,'data/intel',`${new Date().toLocaleDateString('en-CA')}.json`),'saved user work');
  fs.writeFileSync(path.join(root,'skill/bin/collect-outreach.cjs'),`const fs=require('fs'); const args=process.argv.slice(2); const input=args[args.indexOf('--input')+1]; const data=args[args.indexOf('--data-dir')+1]; if(${reject}) process.exit(2); const value=JSON.parse(fs.readFileSync(input)); fs.writeFileSync(data+'/ingested.json',JSON.stringify(value));`);
  fs.writeFileSync(path.join(root,'lib/runtime-shell.sh'),`job_quest_load_runtime() {
JOB_QUEST_ACTIVE_RUNTIME=${runtime}
JOB_QUEST_DATA_DIR="$JOB_QUEST_REPO_ROOT/data"
JOB_QUEST_REFERENCES_DIR="$JOB_QUEST_REPO_ROOT/references"
JOB_QUEST_APP_ROOT="$JOB_QUEST_REPO_ROOT"
JOB_QUEST_RUNTIME_COMMAND=fixture
JOB_QUEST_RUNTIME_COMMAND_ARGS=()
}
job_quest_runtime_hint() { echo fixture; }
job_quest_run_prompt_file() {
cp "$1" "$JOB_QUEST_REPO_ROOT/prompt"
${candidate ? `python3 - "$1" <<'PY'
import json,sys
prompt=open(sys.argv[1]).read()
output=prompt.split('Write one JSON candidate ONLY to ')[1].split('. Do not write')[0]
json.dump({'sources':[{'accountId':'fixture','name':'Fixture','status':'unavailable','checkedAt':None,'detail':'No inbox tools'}],'opportunities':[]},open(output,'w'))
PY` : ':'}
echo 'Fixture completed; no inbox scan'
}
`);
  const run=()=>spawnSync('bash',[path.join(root,'skill/bin/run-daily-intel.sh')],{encoding:'utf8'});
  return {root,run};
}

test('existing daily work permits bounded outreach-only collection and preserves exact file bytes',t=>{
  const {root,run}=fixture(t,{existing:true});
  const before=fs.readFileSync(path.join(root,'data/intel',`${new Date().toLocaleDateString('en-CA')}.json`),'utf8');
  const result=run(); assert.equal(result.status,0,result.stderr);
  const prompt=fs.readFileSync(path.join(root,'prompt'),'utf8');
  assert.match(prompt,/OUTREACH ONLY/);
  assert.ok(prompt.includes(`${root}/data/outreach/brief.json`));
  assert.ok(prompt.includes(`${root}/data/outreach/queue.json`));
  assert.match(prompt,/Reuse the exact existing record id, including legacy ids/);
  assert.match(prompt,/company alone never matches/);
  assert.match(prompt,/Do not merge independently saved records, drafts or decisions/);
  assert.match(prompt,/multiple existing ids match ambiguously, omit that candidate/); assert.doesNotMatch(prompt,/### 1\. Discover/);
  assert.equal(fs.readFileSync(path.join(root,'data/intel',`${new Date().toLocaleDateString('en-CA')}.json`),'utf8'),before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'data/ingested.json'))).sources[0].checkedAt,null);
  assert.equal(fs.readdirSync(path.join(root,'data/logs')).some(name=>name.startsWith('outreach-candidate.')),false);
});
for(const options of [{candidate:false},{reject:true}]) test(`missing or rejected candidate reports failure without ingested state ${JSON.stringify(options)}`,t=>{
  const {root,run}=fixture(t,options); const result=run(); assert.notEqual(result.status,0); assert.equal(fs.existsSync(path.join(root,'data/ingested.json')),false);
});
test('Claude retains restricted tools and public intel when outreach is configured',t=>{
  const {root,run}=fixture(t,{runtime:'claude'}); const result=run(); assert.equal(result.status,0,result.stderr);
  const prompt=fs.readFileSync(path.join(root,'prompt'),'utf8');
  assert.match(prompt,/### 1\. Discover/); assert.match(prompt,/NOT inbox MCP tools/); assert.match(prompt,/actual account identity/); assert.match(prompt,/no messages reviewed|no source review claimed|Missing tools/);
});


test('external designated review with existing daily work skips runtime and outreach ingestion',t=>{
  const {root,run}=fixture(t,{external:true,existing:true}); const result=run();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stderr,/configured external review owns native outreach ingestion/);
  assert.equal(fs.existsSync(path.join(root,'prompt')),false);
  assert.equal(fs.existsSync(path.join(root,'data/ingested.json')),false);
});
test('external designated review retains fresh public native generation without outreach collection',t=>{
  const {root,run}=fixture(t,{external:true,candidate:false}); const result=run();
  assert.equal(result.status,0,result.stderr);
  const prompt=fs.readFileSync(path.join(root,'prompt'),'utf8');
  assert.match(prompt,/### 1\. Discover/);
  assert.doesNotMatch(prompt,/Collect selected outreach sources|Write one JSON candidate ONLY/);
  assert.equal(fs.existsSync(path.join(root,'data/ingested.json')),false);
});
