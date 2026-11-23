// T-0028: install.sh registers Job Quest as the Claude Code plugin job-quest@job-quest-local.
//
// Isolation: every test runs the real install.sh against a fake checkout under a
// temporary HOME, the same way dashboard-control-install.test.js and
// resume-install.test.js do. The PATH is a stub dir plus /usr/bin:/bin. On it:
//   - `claude` is tests/helpers/fake-claude.js (strict flags, state under the temp HOME),
//   - `git` accepts only `pull`, `npm` only `install --silent --omit=optional`, both no-ops,
//   - `uname` says Linux so nothing is compiled,
//   - launchctl, crontab, curl, wget, clang, open, osascript, brew, ssh and sudo are
//     tripwires: any call is recorded and fails the test.
// Nothing here runs the real claude CLI, touches the real ~/.claude, or reaches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fake = require('./helpers/fake-claude');

const ROOT = path.resolve(__dirname, '../..');
const INSTALL = path.join(ROOT, 'install.sh');
const PLUGIN_JSON_REL = 'plugins/job-quest/.claude-plugin/plugin.json';
const PLUGIN_SKILL_REL = 'plugins/job-quest/skills/job-quest/SKILL.md';
const OLD_SKILL = '---\nname: job-quest\n---\nstale skill from an older install\n';

function fixture(t, { claude = true, mode = 'ok', env: extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-plugin-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const stubs = path.join(dir, 'stubs');
  const repo = path.join(home, '.job-quest/app');
  const log = path.join(dir, 'claude.log');
  const tripwireLog = path.join(dir, 'tripwire.log');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'app'));
  fs.mkdirSync(stubs);
  for (const entry of ['skill', 'lib', 'plugins', '.claude-plugin']) {
    if (fs.existsSync(path.join(ROOT, entry))) {
      fs.cpSync(path.join(ROOT, entry), path.join(repo, entry), { recursive: true });
    }
  }
  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  for (const [name, body] of Object.entries({
    git: '[ "$*" = pull ] || { echo "git $*" >> "$TRIPWIRE_LOG"; exit 1; }',
    npm: '[ "$*" = "install --silent --omit=optional" ] || { echo "npm $*" >> "$TRIPWIRE_LOG"; exit 1; }',
    uname: 'echo Linux',
    codex: 'exit 0',
    // Keep runtime command discovery isolated from system login profiles.
    bash: 'if [ "$1" = -lc ]; then shift; exec /bin/bash -c "$@"; fi\nexec /bin/bash "$@"',
  })) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  fake.writeTripwires(stubs);
  if (claude) fake.writeFakeClaude(stubs);
  const baseEnv = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, FAKE_CLAUDE_LOG: log, TRIPWIRE_LOG: tripwireLog, ...extraEnv };
  const claudeDir = fake.claudeDirFor(baseEnv);

  // Run install.sh. `stdin: true` feeds the script on stdin, like `curl ... | bash`.
  const install = ({ mode: runMode = mode, stdin = false } = {}) => {
    const env = { ...baseEnv, FAKE_CLAUDE_MODE: runMode };
    const result = stdin
      ? spawnSync('/bin/bash', [], { env, input: fs.readFileSync(INSTALL), encoding: 'utf8', timeout: 30000 })
      : spawnSync('/bin/bash', [INSTALL], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fake.readTripwires(tripwireLog), [], 'installer tests must not reach launchctl, crontab, the network, or unexpected git/npm commands');
    for (const argv of fake.readLog(log)) {
      assert.equal(fake.parse(argv).error, null, `the real claude CLI rejects this call: claude ${argv.join(' ')}`);
    }
    return result;
  };
  const checkoutFile = rel => {
    const file = path.join(repo, rel);
    assert.ok(fs.existsSync(file), `the checkout must carry ${rel}`);
    return fs.readFileSync(file, 'utf8');
  };
  return {
    dir, home, repo, log, install, claudeDir,
    sourceSkill: () => checkoutFile(PLUGIN_SKILL_REL),
    checkoutVersion: () => JSON.parse(checkoutFile(PLUGIN_JSON_REL)).version,
    legacyDir: path.join(home, '.claude/skills/job-quest'),
    codexSkill: path.join(home, '.codex/skills/job-quest/SKILL.md'),
    runtimeConfig: () => JSON.parse(fs.readFileSync(path.join(home, '.job-quest/config/runtime.json'), 'utf8')),
    calls: () => fake.readLog(log),
  };
}

function pluginRecord(f) {
  const entries = fake.readInstalled(f.claudeDir).plugins[fake.PLUGIN_ID];
  assert.ok(Array.isArray(entries) && entries.length === 1, `${fake.PLUGIN_ID} must be recorded once in installed_plugins.json`);
  return entries[0];
}

function marketplacePath(f) {
  const entry = fake.readKnown(f.claudeDir)[fake.MARKETPLACE];
  assert.ok(entry, `marketplace ${fake.MARKETPLACE} must be registered`);
  return fs.realpathSync(entry.source.path);
}

// The plugin Claude will load is exactly what the installed checkout ships: same
// version, same SKILL.md, from a marketplace that points at this checkout, with
// no second (legacy) copy of the skill next to it.
function assertPluginCurrent(f) {
  const record = pluginRecord(f);
  assert.equal(record.scope, 'user', 'the plugin is installed at user scope');
  assert.equal(marketplacePath(f), fs.realpathSync(f.repo), 'job-quest-local points at the installed checkout');
  assert.equal(record.version, f.checkoutVersion(), 'installed plugin version matches the checkout');
  assert.equal(fs.readFileSync(path.join(record.installPath, 'skills/job-quest/SKILL.md'), 'utf8'), f.sourceSkill(),
    'installed plugin SKILL.md matches the checkout');
  assert.equal(fs.existsSync(f.legacyDir), false, 'no legacy ~/.claude/skills/job-quest next to a working plugin');
  return record;
}

function assertLegacyFallback(f) {
  assert.ok(fs.existsSync(path.join(f.legacyDir, 'SKILL.md')), 'the fallback writes ~/.claude/skills/job-quest/SKILL.md');
  assert.equal(fs.readFileSync(path.join(f.legacyDir, 'SKILL.md'), 'utf8'), f.sourceSkill());
}

function assertCodexUnchanged(f) {
  assert.ok(fs.existsSync(f.codexSkill), 'Codex skill copy is still written');
  assert.equal(fs.readFileSync(f.codexSkill, 'utf8'), f.sourceSkill());
}

function assertReady(f) {
  const config = f.runtimeConfig();
  assert.equal(config.activeRuntime, 'claude');
  assert.equal(config.runtimeValidation.status, 'ready', config.runtimeValidation.lastFailureReason);
}

// Seed an older install: job-quest-local registered at `marketplaceDir` with a
// cached plugin at `version` whose SKILL.md is OLD_SKILL.
function seedOlderPlugin(f, { version = '0.0.1', marketplaceDir = fs.realpathSync(f.repo) } = {}) {
  return fake.seedInstalledPlugin(f.claudeDir, { version, marketplaceDir, skill: OLD_SKILL });
}

// Another checkout (say a dev clone) registered job-quest-local and installed the
// plugin from there, at the same version as the release, so only the content differs.
function seedPluginFromOtherCheckout(f) {
  const version = fs.existsSync(path.join(f.repo, PLUGIN_JSON_REL)) ? f.checkoutVersion() : '0.1.0';
  const other = path.join(f.dir, 'other-checkout');
  const otherSkill = path.join(other, PLUGIN_SKILL_REL);
  fs.mkdirSync(path.dirname(otherSkill), { recursive: true });
  fs.writeFileSync(otherSkill, OLD_SKILL);
  fs.mkdirSync(path.join(other, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(other, 'plugins/job-quest/.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(other, PLUGIN_JSON_REL), JSON.stringify({ name: 'job-quest', version }));
  fs.writeFileSync(path.join(other, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: fake.MARKETPLACE, owner: { name: 'dev' },
    plugins: [{ name: 'job-quest', source: './plugins/job-quest', version }],
  }));
  const installPath = seedOlderPlugin(f, { version, marketplaceDir: fs.realpathSync(other) });
  return { other, otherSkill, installPath };
}

function bumpCheckoutVersion(f, version) {
  const pluginJson = path.join(f.repo, PLUGIN_JSON_REL);
  const marketplaceJson = path.join(f.repo, '.claude-plugin/marketplace.json');
  const plugin = JSON.parse(fs.readFileSync(pluginJson, 'utf8'));
  plugin.version = version;
  fs.writeFileSync(pluginJson, JSON.stringify(plugin, null, 2));
  const marketplace = JSON.parse(fs.readFileSync(marketplaceJson, 'utf8'));
  for (const entry of marketplace.plugins) if (entry.name === 'job-quest') entry.version = version;
  fs.writeFileSync(marketplaceJson, JSON.stringify(marketplace, null, 2));
}

test('a new user with the Claude CLI gets job-quest@job-quest-local installed as a plugin and no legacy copy', t => {
  const f = fixture(t);
  // A legacy copy from an older install must go once the plugin works.
  fs.mkdirSync(f.legacyDir, { recursive: true });
  fs.writeFileSync(path.join(f.legacyDir, 'SKILL.md'), 'stale legacy copy');

  const result = f.install();
  const calls = f.calls();
  const addIndex = fake.callIndex(calls, 'plugin marketplace add');
  assert.ok(addIndex >= 0, `installer must run claude plugin marketplace add; calls: ${JSON.stringify(calls)}`);
  assert.equal(fs.realpathSync(path.resolve(fake.parse(calls[addIndex]).args[0])), fs.realpathSync(f.repo),
    'marketplace source is the installed checkout');
  assert.ok(fake.callIndex(calls, 'plugin install', [fake.PLUGIN_ID]) > addIndex, 'plugin install follows marketplace add');

  assertPluginCurrent(f);
  assertCodexUnchanged(f);
  assertReady(f);
  assert.ok(result.stdout.includes(fake.PLUGIN_ID), 'installer names the registered plugin');
});

test('install.sh piped to bash on stdin (curl | bash) still finishes and registers the plugin', t => {
  // The fake claude drains stdin like a CLI that reads it would. Without a
  // stdin redirect on every claude call, bash loses the rest of the script.
  const f = fixture(t);
  const result = f.install({ stdin: true });
  assert.ok(fake.callIndex(f.calls(), 'plugin install', [fake.PLUGIN_ID]) >= 0, 'plugin install ran from the piped script');
  assertPluginCurrent(f);
  assert.match(result.stdout, /Installation complete!/);
  assertCodexUnchanged(f);
  assertReady(f);
});

test('re-running install (the update path) keeps one marketplace and refreshes the plugin, with or without a version bump', t => {
  const f = fixture(t);
  f.install();
  assertPluginCurrent(f);

  // update.sh pulls a release that bumps the plugin version and edits the skill.
  bumpCheckoutVersion(f, '99.0.0');
  fs.appendFileSync(path.join(f.repo, PLUGIN_SKILL_REL), '\n<!-- updated release -->\n');
  f.install();
  assert.equal(assertPluginCurrent(f).version, '99.0.0');

  // A release that edits the skill but forgets the version bump must not leave stale content.
  fs.appendFileSync(path.join(f.repo, PLUGIN_SKILL_REL), '\n<!-- edited without a version bump -->\n');
  f.install();
  assertPluginCurrent(f);

  // A version-only bump is picked up too.
  bumpCheckoutVersion(f, '99.1.0');
  f.install();
  assert.equal(assertPluginCurrent(f).version, '99.1.0');

  assert.deepEqual(Object.keys(fake.readKnown(f.claudeDir)), [fake.MARKETPLACE], 'exactly one job-quest-local marketplace');
  assert.equal(fake.callIndex(f.calls(), 'plugin marketplace remove'), -1,
    'a marketplace that already points at the checkout is never removed on re-install');
  assertCodexUnchanged(f);
  assertReady(f);
});

for (const addExisting of ['fail', 'replace']) {
  test(`a job-quest-local marketplace registered from another path is re-pointed at the installed checkout (marketplace add on an existing name: ${addExisting})`, t => {
    const f = fixture(t, { env: { FAKE_CLAUDE_ADD_EXISTING: addExisting } });
    const { otherSkill } = seedPluginFromOtherCheckout(f);

    f.install();
    assert.equal(marketplacePath(f), fs.realpathSync(f.repo), 'job-quest-local now points at ~/.job-quest/app, not the other checkout');
    assertPluginCurrent(f);
    assert.deepEqual(Object.keys(fake.readKnown(f.claudeDir)), [fake.MARKETPLACE]);
    assert.equal(fs.readFileSync(otherSkill, 'utf8'), OLD_SKILL, 'the other checkout itself is left alone');
    assertCodexUnchanged(f);
    assertReady(f);
  });
}

test('when the marketplace cannot be re-pointed, the plugin from the other checkout is uninstalled and the legacy copy takes over', t => {
  const f = fixture(t, { mode: 'fail-marketplace' });
  const { installPath } = seedPluginFromOtherCheckout(f);
  f.install();
  const calls = f.calls();
  assert.ok(fake.callIndex(calls, 'plugin uninstall', [fake.PLUGIN_ID]) >= 0,
    `the plugin from the wrong checkout is uninstalled before falling back; calls: ${JSON.stringify(calls)}`);
  assert.equal(fake.readInstalled(f.claudeDir).plugins[fake.PLUGIN_ID], undefined, 'no wrong-source plugin record next to the fallback');
  assert.equal(fs.existsSync(path.join(installPath, 'skills/job-quest/SKILL.md')), false);
  assertLegacyFallback(f);
  assertCodexUnchanged(f);
  assertReady(f);
});

test('when claude plugin update fails over an older installed plugin, the installer still ends with the current plugin', t => {
  const f = fixture(t, { mode: 'fail-update' });
  seedOlderPlugin(f);
  f.install();
  assert.ok(f.calls().length > 0, 'the installer drove the claude CLI');
  // Never "success" with the old content: the plugin is re-installed from the checkout.
  assertPluginCurrent(f);
  assertCodexUnchanged(f);
  assertReady(f);
});

test('when an older plugin cannot be refreshed at all, it is uninstalled and the legacy copy takes over', t => {
  const f = fixture(t, { mode: 'fail-install,fail-update' });
  const oldInstallPath = seedOlderPlugin(f);
  f.install();
  const calls = f.calls();
  assert.ok(fake.callIndex(calls, 'plugin uninstall', [fake.PLUGIN_ID]) >= 0,
    `the stale plugin is uninstalled before falling back; calls: ${JSON.stringify(calls)}`);
  assert.equal(fake.readInstalled(f.claudeDir).plugins[fake.PLUGIN_ID], undefined, 'no stale plugin record next to the fallback');
  assert.equal(fs.existsSync(path.join(oldInstallPath, 'skills/job-quest/SKILL.md')), false);
  assertLegacyFallback(f);
  assertCodexUnchanged(f);
  assertReady(f);
});

test('when a stale plugin can be neither refreshed nor removed, the installer falls back and prints the manual cleanup command', t => {
  const f = fixture(t, { mode: 'fail-all' });
  seedOlderPlugin(f);
  const result = f.install();
  assert.ok(f.calls().length > 0, 'the installer tried the claude CLI');
  assertLegacyFallback(f);
  assert.match(result.stdout + result.stderr, /claude plugin uninstall job-quest@job-quest-local/,
    'the user is told how to remove the stale plugin by hand');
  assertCodexUnchanged(f);
  assertReady(f);
});

test('with CLAUDE_CONFIG_DIR set, the plugin is found in that config dir and no legacy copy is written', t => {
  const custom = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jq-plugin-config-')), 'claude-config');
  t.after(() => fs.rmSync(path.dirname(custom), { recursive: true, force: true }));
  const f = fixture(t, { env: { CLAUDE_CONFIG_DIR: custom } });
  fs.mkdirSync(f.legacyDir, { recursive: true });
  fs.writeFileSync(path.join(f.legacyDir, 'SKILL.md'), 'stale legacy copy');

  f.install();
  assert.equal(f.claudeDir, custom);
  assertPluginCurrent(f);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/plugins')), false, 'plugin state lives only under CLAUDE_CONFIG_DIR');
  assertCodexUnchanged(f);
  assertReady(f);
  assert.equal(f.runtimeConfig().runtimeValidation.lastFailureReason, null);
});

test('without the Claude CLI the installer falls back to the legacy ~/.claude/skills copy', t => {
  const f = fixture(t, { claude: false });
  f.install();
  assert.equal(fs.existsSync(f.log), false, 'no claude invocations');
  assertLegacyFallback(f);
  assert.equal(fs.existsSync(fake.installedFile(f.claudeDir)), false);
  assertCodexUnchanged(f);
});

test('when claude plugin install fails the installer writes the legacy copy and still finishes ready', t => {
  const f = fixture(t, { mode: 'fail-install' });
  f.install();
  const calls = f.calls();
  assert.ok(fake.callIndex(calls, 'plugin install', [fake.PLUGIN_ID]) >= 0, `plugin install was attempted; calls: ${JSON.stringify(calls)}`);
  assertLegacyFallback(f);
  assert.equal(fake.readInstalled(f.claudeDir).plugins[fake.PLUGIN_ID], undefined);
  assertCodexUnchanged(f);
  assertReady(f);
});

test('a plugin install that exits 0 but records no plugin counts as failed and keeps the legacy copy', t => {
  const f = fixture(t, { mode: 'no-record' });
  f.install();
  const calls = f.calls();
  assert.ok(fake.callIndex(calls, 'plugin install', [fake.PLUGIN_ID]) >= 0, `plugin install was attempted; calls: ${JSON.stringify(calls)}`);
  assertLegacyFallback(f);
  assertCodexUnchanged(f);
  assertReady(f);
});
