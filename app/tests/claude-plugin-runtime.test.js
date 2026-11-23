// T-0028: lib/runtime.js accepts the Claude Code plugin install as Claude registration.
// Runs only lib/runtime.js with a temporary HOME and stub `claude`/`codex` that do nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const RUNTIME = path.join(ROOT, 'lib', 'runtime.js');

// `claudeDir` is where Claude Code keeps its state: ~/.claude unless CLAUDE_CONFIG_DIR says otherwise.
function fixture(t, { claudeDir: claudeDirRel = '.claude' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-plugin-runtime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeDir = path.join(home, claudeDirRel);
  const stubs = path.join(home, 'stubs');
  fs.mkdirSync(stubs);
  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  for (const [name, body] of Object.entries({
    claude: 'exit 0',
    codex: 'exit 0',
    // Keep runtime command discovery isolated from system login profiles.
    bash: 'if [ "$1" = -lc ]; then shift; exec /bin/bash -c "$@"; fi\nexec /bin/bash "$@"',
  })) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const installPath = path.join(claudeDir, 'plugins/cache/job-quest-local/job-quest/1.2.3');
  const pluginSkill = path.join(installPath, 'skills/job-quest/SKILL.md');
  const recordPlugin = () => {
    const file = path.join(claudeDir, 'plugins/installed_plugins.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      plugins: {
        'job-quest@job-quest-local': [{
          scope: 'user', installPath, version: '1.2.3',
          installedAt: '2026-11-22T00:00:00.000Z', lastUpdated: '2026-11-22T00:00:00.000Z',
        }],
      },
    }, null, 2));
  };
  const writePluginSkill = () => {
    fs.mkdirSync(path.dirname(pluginSkill), { recursive: true });
    fs.writeFileSync(pluginSkill, '---\nname: job-quest\n---\n');
  };
  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [RUNTIME, ...args], {
      env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...env }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  return { home, claudeDir, installPath, pluginSkill, recordPlugin, writePluginSkill, run };
}

function registrationPathLine(out) {
  const line = out.split('\n').find(l => l.startsWith('export JOB_QUEST_RUNTIME_REGISTRATION_PATH='));
  assert.ok(line, out);
  return line;
}

test('Claude registration is satisfied by the installed job-quest plugin, with no legacy skill copy', t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/skills/job-quest')), false);

  // A plugin record whose cache lacks the skill is not a registration.
  f.recordPlugin();
  let config = JSON.parse(f.run(['ensure', '--require-registration']));
  assert.equal(config.activeRuntime, 'claude');
  assert.equal(config.runtimeValidation.status, 'degraded');

  f.writePluginSkill();
  config = JSON.parse(f.run(['ensure', '--require-registration']));
  assert.equal(config.activeRuntime, 'claude');
  assert.equal(config.runtimeCommand, 'claude');
  assert.equal(config.runtimeValidation.status, 'ready', config.runtimeValidation.lastFailureReason);
  assert.equal(config.runtimeValidation.lastFailureReason, null);

  // Codex is unchanged: the Claude plugin never stands in for ~/.codex/skills/job-quest.
  // A failed switch keeps the saved runtime and records why Codex was refused.
  config = JSON.parse(f.run(['ensure', '--require-registration'], { JOB_QUEST_RUNTIME: 'codex' }));
  assert.equal(config.activeRuntime, 'claude');
  assert.match(String(config.runtimeValidation.lastFailureReason), /\.codex\/skills\/job-quest\/SKILL\.md/);
  fs.mkdirSync(path.join(f.home, '.codex/skills/job-quest'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.codex/skills/job-quest/SKILL.md'), 'codex');
  config = JSON.parse(f.run(['ensure', '--require-registration'], { JOB_QUEST_RUNTIME: 'codex' }));
  assert.equal(config.activeRuntime, 'codex');
  assert.equal(config.runtimeValidation.status, 'ready', config.runtimeValidation.lastFailureReason);
});

test('shell exports point the Claude registration path at the plugin SKILL.md', t => {
  const f = fixture(t);
  f.recordPlugin();
  f.writePluginSkill();
  const out = f.run(['shell', '--require-registration']);
  assert.equal(registrationPathLine(out), `export JOB_QUEST_RUNTIME_REGISTRATION_PATH='${f.pluginSkill}'`);
});

test('CLAUDE_CONFIG_DIR moves the plugin lookup: a plugin installed there registers Claude without ~/.claude', t => {
  const f = fixture(t, { claudeDir: 'custom-claude-config' });
  const env = { CLAUDE_CONFIG_DIR: f.claudeDir };
  f.recordPlugin();
  f.writePluginSkill();
  assert.equal(fs.existsSync(path.join(f.home, '.claude')), false, 'nothing is installed under ~/.claude in this test');

  const config = JSON.parse(f.run(['ensure', '--require-registration'], env));
  assert.equal(config.activeRuntime, 'claude');
  assert.equal(config.runtimeValidation.status, 'ready', config.runtimeValidation.lastFailureReason);

  const out = f.run(['shell', '--require-registration'], env);
  assert.equal(registrationPathLine(out), `export JOB_QUEST_RUNTIME_REGISTRATION_PATH='${f.pluginSkill}'`);
});
