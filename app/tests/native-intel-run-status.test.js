const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../../skill/bin/run-daily-intel.sh');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// agentBody runs inside the runner's shell in place of the real runtime CLI.
function fixture(t, agentBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-intel-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['skill/bin', 'lib', 'data', 'references', 'app/lib/intel-control']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(source, path.join(root, 'skill/bin/run-daily-intel.sh'));
  fs.copyFileSync(path.resolve(__dirname, '../lib/intel-control/lock.js'), path.join(root, 'app/lib/intel-control/lock.js'));
  fs.copyFileSync(path.resolve(__dirname, '../lib/intel-control/preferences.js'), path.join(root, 'app/lib/intel-control/preferences.js'));
  fs.mkdirSync(path.join(root,'app/lib/outreach'),{recursive:true});
  fs.copyFileSync(path.resolve(__dirname,'../lib/outreach/conversation-review.js'),path.join(root,'app/lib/outreach/conversation-review.js'));
  fs.writeFileSync(path.join(root, 'data/profile.json'), JSON.stringify({ name: 'Fixture', targetCompanies: {} }));
  fs.writeFileSync(path.join(root, 'references/intel-agent-template.md'), 'Fixture template');
  fs.writeFileSync(path.join(root, 'lib/runtime-shell.sh'), `job_quest_load_runtime() {\n export JOB_QUEST_ACTIVE_RUNTIME=claude\n export JOB_QUEST_DATA_DIR="$JOB_QUEST_REPO_ROOT/data"\n export JOB_QUEST_REFERENCES_DIR="$JOB_QUEST_REPO_ROOT/references"\n export JOB_QUEST_APP_ROOT="$JOB_QUEST_REPO_ROOT"\n export JOB_QUEST_RUNTIME_COMMAND=claude\n JOB_QUEST_RUNTIME_COMMAND_ARGS=()\n}\njob_quest_runtime_hint() { echo fixture; }\njob_quest_run_prompt_file() {\n cp "$1" "$JOB_QUEST_REPO_ROOT/captured-prompt"\n ${agentBody}\n}\n`);
  const data = path.join(root, 'data');
  const run = () => spawnSync('bash', [path.join(root, 'skill/bin/run-daily-intel.sh')], { encoding: 'utf8' });
  const lastRun = () => JSON.parse(fs.readFileSync(path.join(data, 'logs/daily-intel-last-run.json'), 'utf8'));
  return { root, data, run, lastRun };
}

const writesEverything = `D="$JOB_QUEST_DATA_DIR"; T="$(date +%Y-%m-%d)"; mkdir -p "$D/intel" "$D/quizzes"
 echo '{"roles":[{"company":"A"}]}' > "$D/intel/$T.json"
 echo '{"questions":[]}' > "$D/quizzes/$T.json"
 echo '{"tasks":[{"text":"intel task","category":"coding","completed":false}]}' > "$TASKS_CANDIDATE"
 echo 'Done: 1 roles, 0 quiz questions, 1 tasks, 0 new problems'`;

test('a prep-plan tasks file for today no longer blocks discovery, and its tasks are kept', t => {
  const f = fixture(t, writesEverything);
  fs.mkdirSync(path.join(f.data, 'tasks'));
  const planned = { date: today(), tasks: [{ text: 'planned drill', category: 'coding', completed: true, planId: 'prep-x' }] };
  fs.writeFileSync(path.join(f.data, 'tasks', `${today()}.json`), JSON.stringify(planned));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(f.root, 'captured-prompt'), 'utf8'), /Discover 15-20 new roles/);
  const tasks = JSON.parse(fs.readFileSync(path.join(f.data, 'tasks', `${today()}.json`), 'utf8')).tasks;
  assert.deepEqual(tasks.map(x => x.text), ['planned drill', 'intel task']);
  assert.equal(tasks[0].completed, true, 'existing task state preserved');
  assert.equal(tasks[1].source, 'intel');
  const last = f.lastRun();
  assert.equal(last.status, 'completed');
  assert.match(last.summary, /Done: 1 roles/);
  assert.ok(last.startedAt && last.finishedAt);
});

test('complete legacy daily files record a visible skip without invoking the agent', t => {
  const f = fixture(t, 'touch "$JOB_QUEST_REPO_ROOT/agent-ran"');
  fs.mkdirSync(path.join(f.data, 'intel'));
  fs.writeFileSync(path.join(f.data, 'intel', `${today()}.json`), '{"roles":[]}');
  for(const dir of ['quizzes','tasks']) { fs.mkdirSync(path.join(f.data,dir));fs.writeFileSync(path.join(f.data,dir,`${today()}.json`),'{}'); }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'agent-ran')), false);
  const last = f.lastRun();
  assert.equal(last.status, 'skipped');
  assert.match(last.reason, /intel/);
});

test('an agent that exits 0 without writing intel is recorded as failed', t => {
  const f = fixture(t, "echo 'I could not do it'");
  const result = f.run();
  assert.notEqual(result.status, 0);
  const last = f.lastRun();
  assert.equal(last.status, 'failed');
  assert.match(last.reason, /intel/);
});

const selected=()=>({schema:'job-quest-intel-preferences/1',scopes:{jobs:false,outreach:false,practice:false}});
const scopedAgent=`D="$JOB_QUEST_DATA_DIR"; T="$(date +%Y-%m-%d)"
if [ "$GENERATE_JOBS" -eq 1 ]; then mkdir -p "$D/intel";echo '{"roles":[]}' > "$D/intel/$T.json";fi
if [ "$GENERATE_PRACTICE" -eq 1 ]; then
 mkdir -p "$D/quizzes"
 if [ "$QUIZ_PRESENT" -eq 0 ]; then echo '{"questions":[]}' > "$D/quizzes/$T.json";fi
 echo '{"tasks":[{"text":"new drill"}]}' > "$TASKS_CANDIDATE"
fi
if [ "$COLLECT_OUTREACH" -eq 1 ]; then echo '{"sources":[],"opportunities":[]}' > "$OUTREACH_CANDIDATE";fi
echo 'Scoped mock completed'`;
function config(f,scopes){fs.writeFileSync(path.join(f.data,'intel-preferences.json'),JSON.stringify({schema:'job-quest-intel-preferences/1',scopes}));}
function accounts(f){fs.writeFileSync(path.join(f.data,'opportunity-accounts.json'),JSON.stringify({accounts:[{id:'fixture',label:'fixture@example.test',kind:'gmail'}]}));fs.writeFileSync(path.join(f.root,'skill/bin/collect-outreach.cjs'),`require('fs').writeFileSync(require('path').join(process.argv[process.argv.indexOf('--data-dir')+1],'outreach-ingested'),'yes');`);}
for(let mask=1;mask<8;mask++)test(`runner honors independently selected activities ${mask}`,t=>{
 const f=fixture(t,scopedAgent),scopes={jobs:!!(mask&1),outreach:!!(mask&2),practice:!!(mask&4)};config(f,scopes);accounts(f);
 const result=f.run();assert.equal(result.status,0,result.stderr);assert.equal(f.lastRun().status,'completed');
 assert.equal(fs.existsSync(path.join(f.data,'intel',`${today()}.json`)),scopes.jobs);
 assert.equal(fs.existsSync(path.join(f.data,'quizzes',`${today()}.json`)),scopes.practice);
 assert.equal(fs.existsSync(path.join(f.data,'tasks',`${today()}.json`)),scopes.practice);
 assert.equal(fs.existsSync(path.join(f.data,'outreach-ingested')),scopes.outreach);
 const prompt=fs.readFileSync(path.join(f.root,'captured-prompt'),'utf8');
 assert.equal(prompt.includes('### 1. Discover 15-20 new roles'),scopes.jobs);
 assert.equal(prompt.includes('### 3. Create a 5-7 question quiz'),scopes.practice);
 assert.equal(prompt.includes('## Collect selected outreach sources'),scopes.outreach);
});
test('outreach-only respects external ownership without launching a native runtime',t=>{
 const f=fixture(t,scopedAgent);config(f,{jobs:false,outreach:true,practice:false});accounts(f);fs.writeFileSync(path.join(f.data,'local-setup.json'),'{"schedule":"external"}');
 assert.equal(f.run().status,0);assert.equal(f.lastRun().status,'skipped');assert.equal(fs.existsSync(path.join(f.root,'captured-prompt')),false);assert.equal(fs.existsSync(path.join(f.data,'outreach-ingested')),false);
});
for(const value of [selected(),{schema:'wrong',scopes:{jobs:true,outreach:true,practice:true}},{schema:'job-quest-intel-preferences/1',scopes:{jobs:true}}])test(`disabled or invalid configuration never launches runtime ${JSON.stringify(value)}`,t=>{
 const f=fixture(t,scopedAgent);fs.writeFileSync(path.join(f.data,'intel-preferences.json'),JSON.stringify(value));const result=f.run();assert.equal(result.status,value.schema==='job-quest-intel-preferences/1'&&value.scopes.practice===false?0:1);assert.equal(fs.existsSync(path.join(f.root,'captured-prompt')),false);
});
test('jobs marker cannot suppress practice, existing quiz and task state survive, and practice repeats skip',t=>{
 const f=fixture(t,scopedAgent);config(f,{jobs:false,outreach:false,practice:true});
 fs.mkdirSync(path.join(f.data,'quizzes'));fs.mkdirSync(path.join(f.data,'tasks'));const quiz=path.join(f.data,'quizzes',`${today()}.json`),tasks=path.join(f.data,'tasks',`${today()}.json`);
 fs.writeFileSync(quiz,'{"questions":[{"id":"saved"}]}');fs.writeFileSync(tasks,JSON.stringify({tasks:[{text:'saved drill',completed:true}]}));
 assert.equal(f.run().status,0);assert.equal(fs.readFileSync(quiz,'utf8'),'{"questions":[{"id":"saved"}]}');assert.deepEqual(JSON.parse(fs.readFileSync(tasks)).tasks.map(x=>[x.text,x.completed]),[['saved drill',true],['new drill',false]]);
 fs.unlinkSync(path.join(f.root,'captured-prompt'));assert.equal(f.run().status,0);assert.equal(f.lastRun().status,'skipped');assert.equal(fs.existsSync(path.join(f.root,'captured-prompt')),false);
});
test('an existing discovery file alone allows missing practice to be prepared without replacing roles',t=>{
 const f=fixture(t,scopedAgent);fs.mkdirSync(path.join(f.data,'intel'));const intel=path.join(f.data,'intel',`${today()}.json`);fs.writeFileSync(intel,'{"roles":[{"id":"saved"}]}');
 assert.equal(f.run().status,0);assert.equal(fs.readFileSync(intel,'utf8'),'{"roles":[{"id":"saved"}]}');assert.equal(fs.existsSync(path.join(f.data,'quizzes',`${today()}.json`)),true);
});
test('successful practice is not generated twice when another enabled activity fails',t=>{
 const f=fixture(t,scopedAgent);config(f,{jobs:false,outreach:true,practice:true});accounts(f);const collector=path.join(f.root,'skill/bin/collect-outreach.cjs');fs.writeFileSync(collector,'process.exit(1)');assert.equal(f.run().status,1);assert.equal(fs.existsSync(path.join(f.data,'logs',`.daily-intel-practice-${today()}.json`)),true);const tasks=fs.readFileSync(path.join(f.data,'tasks',`${today()}.json`),'utf8');
 accounts(f);assert.equal(f.run().status,0);assert.equal(fs.readFileSync(path.join(f.data,'tasks',`${today()}.json`),'utf8'),tasks);const prompt=fs.readFileSync(path.join(f.root,'captured-prompt'),'utf8');assert.doesNotMatch(prompt,/### 3. Create a 5-7 question quiz/);assert.match(prompt,/Collect selected outreach sources/);
});
