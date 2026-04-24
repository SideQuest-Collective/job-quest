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
    `job_quest_run_prompt_file ${shellQuote(promptPath)} --full-auto`,
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
    assert.match(result.stdout, /--full-auto/);
  } finally {
    fs.unlinkSync(promptPath);
  }
});
