const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../../skill/bin/run-daily-intel.sh');

function captureDailyPrompt(t, { intel = {}, tracker = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-intel-variety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['skill/bin', 'lib', 'data/intel', 'references', 'app/lib/intel-control']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(source, path.join(root, 'skill/bin/run-daily-intel.sh'));
  fs.copyFileSync(path.resolve(__dirname, '../lib/intel-control/lock.js'), path.join(root, 'app/lib/intel-control/lock.js'));
  fs.writeFileSync(path.join(root, 'data/profile.json'), JSON.stringify({ name: 'Fixture', targetCompanies: {} }));
  fs.writeFileSync(path.join(root, 'data/role-tracker.json'), JSON.stringify(tracker));
  for (const [name, roles] of Object.entries(intel)) fs.writeFileSync(path.join(root, 'data/intel', name), JSON.stringify({ roles }));
  fs.writeFileSync(path.join(root, 'references/intel-agent-template.md'), 'Fixture template');
  fs.writeFileSync(path.join(root, 'lib/runtime-shell.sh'), `job_quest_load_runtime() {\n export JOB_QUEST_ACTIVE_RUNTIME=claude\n export JOB_QUEST_DATA_DIR="$JOB_QUEST_REPO_ROOT/data"\n export JOB_QUEST_REFERENCES_DIR="$JOB_QUEST_REPO_ROOT/references"\n export JOB_QUEST_APP_ROOT="$JOB_QUEST_REPO_ROOT"\n export JOB_QUEST_RUNTIME_COMMAND=claude\n JOB_QUEST_RUNTIME_COMMAND_ARGS=()\n}\njob_quest_runtime_hint() { echo fixture; }\njob_quest_run_prompt_file() {\n cp "$1" "$JOB_QUEST_REPO_ROOT/captured-prompt"\n}\n`);
  spawnSync('bash', [path.join(root, 'skill/bin/run-daily-intel.sh')], { encoding: 'utf8' });
  return fs.readFileSync(path.join(root, 'captured-prompt'), 'utf8');
}

test('discovery prompt names companies already shown or tracked so the agent finds new ones', (t) => {
  const prompt = captureDailyPrompt(t, {
    intel: { '2026-01-01.json': [{ company: 'Acme Robotics', role: 'Senior SWE', url: 'https://jobs.example/acme/1' }] },
    tracker: { 'Beta Labs|Staff Engineer': { stage: 'applied' } },
  });
  const section = prompt.split('## Variety')[1] || '';
  assert.match(section, /Acme Robotics/);
  assert.match(section, /Beta Labs/);
  assert.match(section, /at most 2 roles per company/i);
});

test('discovery prompt asks for a mix of established companies and startups', (t) => {
  const prompt = captureDailyPrompt(t);
  assert.match(prompt.split('## Variety')[1] || '', /established/i);
});
