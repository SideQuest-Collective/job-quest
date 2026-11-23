// T-0028: uninstall.sh removes the Claude Code plugin and its marketplace, tolerating CLI failures.
// Uses a fake `claude` (tests/helpers/fake-claude.js, strict flags) and a temporary HOME; never the real
// CLI or ~/.claude. launchctl, crontab, lsof, ps, open and rm are harmless stubs, as in
// uninstall-script.test.js; curl, wget, git, npm, osascript, brew, ssh and sudo are tripwires.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fake = require('./helpers/fake-claude');

const UNINSTALL = path.resolve(__dirname, '../../skill/bin/uninstall.sh');

function runUninstall(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-plugin-uninstall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const stubs = path.join(dir, 'stubs');
  const tmp = path.join(dir, 'tmp');
  const log = path.join(dir, 'claude.log');
  const tripwireLog = path.join(dir, 'tripwire.log');
  for (const directory of [stubs, tmp, path.join(home, '.job-quest/data')]) fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  for (const [name, body] of Object.entries({
    lsof: 'exit 1',
    ps: 'exit 1',
    launchctl: 'exit 0',
    crontab: 'exit 1',
    open: 'exit 0',
    // The uninstaller also cleans global /tmp globs; never let tests touch those.
    rm: 'for arg in "$@"; do case "$arg" in -*) ;; "$TEST_DIR"/*) ;; *) exit 0 ;; esac; done; /bin/rm "$@"',
  })) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  fake.writeTripwires(stubs, ['curl', 'wget', 'git', 'npm', 'osascript', 'brew', 'ssh', 'sudo']);
  fake.writeFakeClaude(stubs);
  const claudeDir = path.join(home, '.claude');
  fake.seedInstalledPlugin(claudeDir, { marketplaceDir: path.join(home, '.job-quest/app') });
  const legacyDir = path.join(home, '.claude/skills/job-quest');
  const codexDir = path.join(home, '.codex/skills/job-quest');
  for (const skillDir of [legacyDir, codexDir]) {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill');
  }
  const result = spawnSync('/bin/bash', [UNINSTALL, '--yes'], {
    env: {
      HOME: home, TMPDIR: tmp, PATH: `${stubs}:/usr/bin:/bin`, TEST_DIR: dir,
      FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode, TRIPWIRE_LOG: tripwireLog,
    },
    encoding: 'utf8', timeout: 10000,
  });
  assert.deepEqual(fake.readTripwires(tripwireLog), [], 'uninstall tests must not reach the network, git or npm');
  const calls = fake.readLog(log);
  for (const argv of calls) {
    assert.equal(fake.parse(argv).error, null, `the real claude CLI rejects this call: claude ${argv.join(' ')}`);
  }
  return { result, home, claudeDir, legacyDir, codexDir, calls };
}

test('uninstall removes the job-quest plugin, then the job-quest-local marketplace, and both skill copies', t => {
  const { result, home, claudeDir, legacyDir, codexDir, calls } = runUninstall(t, 'ok');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Job Quest has been uninstalled/);
  const uninstall = fake.callIndex(calls, 'plugin uninstall', [fake.PLUGIN_ID]);
  const remove = fake.callIndex(calls, 'plugin marketplace remove', [fake.MARKETPLACE]);
  assert.ok(uninstall >= 0, `claude plugin uninstall ${fake.PLUGIN_ID} must run; calls: ${JSON.stringify(calls)}`);
  assert.ok(remove > uninstall, 'marketplace removal follows plugin uninstall');
  assert.equal(fake.readInstalled(claudeDir).plugins[fake.PLUGIN_ID], undefined);
  assert.equal(fake.readKnown(claudeDir)[fake.MARKETPLACE], undefined);
  assert.equal(fs.existsSync(legacyDir), false);
  assert.equal(fs.existsSync(codexDir), false);
  assert.equal(fs.existsSync(path.join(home, '.job-quest')), false);
});

test('uninstall still completes when every claude plugin command fails', t => {
  const { result, legacyDir, codexDir, calls } = runUninstall(t, 'fail-all');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Job Quest has been uninstalled/);
  assert.ok(fake.callIndex(calls, 'plugin uninstall', [fake.PLUGIN_ID]) >= 0, `plugin uninstall was attempted; calls: ${JSON.stringify(calls)}`);
  assert.equal(fs.existsSync(legacyDir), false);
  assert.equal(fs.existsSync(codexDir), false);
});
