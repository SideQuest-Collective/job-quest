const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

test('Codex dry-run includes writable data and references dirs', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const promptPath = path.join(os.tmpdir(), 'job-quest-runtime-shell-test.txt');
  fs.writeFileSync(promptPath, 'test prompt\n');

  const command = [
    'source lib/runtime-shell.sh',
    'export JOB_QUEST_ACTIVE_RUNTIME=codex',
    'export JOB_QUEST_RUNTIME_COMMAND=codex',
    'export JOB_QUEST_APP_ROOT=/tmp/job-quest-app',
    'export JOB_QUEST_DATA_DIR=/tmp/job-quest-data',
    'export JOB_QUEST_REFERENCES_DIR=/tmp/job-quest-references',
    'export JOB_QUEST_RUNTIME_DRY_RUN=1',
    'JOB_QUEST_RUNTIME_COMMAND_ARGS=(exec)',
    `job_quest_run_prompt_file ${shellQuote(promptPath)} --approve-for-me`,
  ].join('\n');

  const result = spawnSync('bash', ['-lc', command], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /codex exec/);
    assert.match(result.stdout, /-C \/tmp\/job-quest-app/);
    assert.match(result.stdout, /--add-dir \/tmp\/job-quest-data/);
    assert.match(result.stdout, /--add-dir \/tmp\/job-quest-references/);
    assert.match(result.stdout, /--approve-for-me/);
  } finally {
    fs.unlinkSync(promptPath);
  }
});


test('daily runner uses automatic approval without conflicting sandbox option', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const runner = fs.readFileSync(path.join(repoRoot, 'skill/bin/run-daily-intel.sh'), 'utf8');
  const invocation = runner.match(/job_quest_run_prompt_file "\$PROMPT_FILE" ([^>]+)>/)[1];
  assert.match(invocation, /--approve-for-me/);
  assert.doesNotMatch(invocation, /--sandbox|--full-auto|--dangerously-bypass/);
  const help = spawnSync('codex', ['exec', '--help'], { encoding: 'utf8', timeout: 10000 });
  if (help.error?.code === 'ENOENT') return;
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--approve-for-me\s+Route approval requests through automatic review using the workspace-write sandbox/);
});


test('existing dated native output stops the actual helper before generation', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-preserve-daily-'));
  const fixtureHome = path.join(fixture, 'home');
  const product = path.join(fixtureHome, '.job-quest');
  const data = path.join(product, 'data');
  const mkdir = p => fs.mkdirSync(p, { recursive: true });
  mkdir(path.join(product, 'app/lib'));
  mkdir(path.join(product, 'bin'));
  mkdir(path.join(product, 'references'));
  mkdir(path.join(fixtureHome, '.codex/skills/job-quest'));
  for (const file of ['runtime.js', 'runtime-shell.sh']) fs.copyFileSync(path.join(repoRoot, 'lib', file), path.join(product, 'app/lib', file));
  const helper = path.join(product, 'bin/run-daily-intel.sh');
  fs.copyFileSync(path.join(repoRoot, 'skill/bin/run-daily-intel.sh'), helper);
  fs.writeFileSync(path.join(product, 'references/intel-agent-template.md'), 'Fixture only');
  fs.writeFileSync(path.join(fixtureHome, '.codex/skills/job-quest/SKILL.md'), 'Fixture registration');
  mkdir(data);
  fs.writeFileSync(path.join(data, 'profile.json'), JSON.stringify({ name: 'Fixture' }));
  const preload = path.join(fixture, 'home.cjs');
  fs.writeFileSync(preload, 'require("os").homedir = () => process.env.JOB_QUEST_FIXTURE_HOME;');
  const date = spawnSync('date', ['+%Y-%m-%d'], { encoding: 'utf8' }).stdout.trim();
  try {
    for (const kind of ['intel', 'quizzes', 'tasks']) {
      mkdir(path.join(data, kind));
      const output = path.join(data, kind, `${date}.json`);
      const original = JSON.stringify({ date, userWork: 'preserve exactly' });
      fs.writeFileSync(output, original);
      const result = spawnSync('bash', [helper], { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NODE_OPTIONS: `--require ${preload}`, JOB_QUEST_FIXTURE_HOME: fixtureHome, JOB_QUEST_SYSTEM_HOME: os.homedir(), JOB_QUEST_RUNTIME: 'codex' } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`SKIP: existing ${kind}/${date}`));
      assert.equal(fs.readFileSync(output, 'utf8'), original);
      fs.unlinkSync(output);
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
