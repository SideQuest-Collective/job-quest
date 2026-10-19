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

test('an existing intel file for today records a visible skip without invoking the agent', t => {
  const f = fixture(t, 'touch "$JOB_QUEST_REPO_ROOT/agent-ran"');
  fs.mkdirSync(path.join(f.data, 'intel'));
  fs.writeFileSync(path.join(f.data, 'intel', `${today()}.json`), '{"roles":[]}');
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
