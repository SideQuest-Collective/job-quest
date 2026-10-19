'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../../lib/runtime-shell.sh'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-runtime-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'user home');
  fs.mkdirSync(home);
  const systemBin = path.join(root, 'system/bin');
  const systemUsrBin = path.join(root, 'system/usr/bin');
  fs.mkdirSync(systemBin, { recursive: true });
  fs.mkdirSync(systemUsrBin, { recursive: true });
  // Supply only the commands needed by the nvm fallback. A Node installed in
  // the host's /usr/bin must not leak into our simulated launchd environment.
  for (const command of ['ls', 'sort', 'tail']) {
    const executable = ['/usr/bin', '/bin'].map(dir => path.join(dir, command))
      .find(candidate => fs.existsSync(candidate));
    assert.ok(executable, `Missing test prerequisite: ${command}`);
    fs.symlinkSync(executable, path.join(systemUsrBin, command));
  }
  // Redirect only fixed installation roots so tests never depend on or modify
  // tools installed on the test machine. The shell discovery logic is unchanged.
  const isolated = source
    .replaceAll('/opt/homebrew', `${root}/opt/homebrew`)
    .replaceAll('/usr/local', `${root}/usr/local`)
    .replace('in /Applications ', `in "${root}/Applications" `);
  const script = path.join(root, 'runtime-shell.sh');
  fs.writeFileSync(script, isolated);
  return {
    root, home,
    dir(relative) {
      const dir = path.join(root, relative);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    tool(relative, name, executable = true) {
      const dir = this.dir(relative);
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: executable ? 0o755 : 0o644 });
      return dir;
    },
    run(initialPath = '/usr/bin:/bin', extra = '', env = {}) {
      const isolatedPath = initialPath.split(':').map(dir => {
        if (dir === '/usr/bin') return systemUsrBin;
        if (dir === '/bin') return systemBin;
        return dir;
      }).join(':');
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', `
        source "$1"
        job_quest_ensure_tool_path
        ${extra}
        printf '%s\\n' "$PATH"
        command -v node || :
        command -v codex || :
      `, 'runtime-path-test', script], {
        env: { HOME: home, PATH: isolatedPath, ...env },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.replaceAll(systemUsrBin, '/usr/bin')
        .replaceAll(systemBin, '/bin').trimEnd().split('\n');
    },
  };
}

test('minimal launchd PATH discovers versioned Homebrew Node and bundled Codex', t => {
  const f = fixture(t);
  const brew = f.dir('opt/homebrew/bin');
  const local = f.dir('usr/local/bin');
  const user = f.dir('user home/.local/bin');
  const node = f.tool('opt/homebrew/opt/node@26/bin', 'node');
  const codex = f.tool('Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS', 'codex');
  const result = f.run();
  assert.deepEqual(result, [
    ['/usr/bin', '/bin', brew, local, user, node, codex].join(':'),
    `${node}/node`, `${codex}/codex`,
  ]);
});

test('an existing Homebrew entry does not suppress other missing paths; repeated calls are idempotent', t => {
  const f = fixture(t);
  const brew = f.dir('opt/homebrew/bin');
  const local = f.dir('usr/local/bin');
  const user = f.dir('user home/.local/bin');
  const node = f.tool('usr/local/opt/node@22/bin', 'node');
  const codex = f.tool('user home/Applications/Codex.app/Contents/Resources', 'codex');
  const initial = `${brew}:/usr/bin:/bin`;
  const once = f.run(initial);
  assert.deepEqual(f.run(initial, 'job_quest_ensure_tool_path'), once);
  assert.equal(once[0], `${initial}:${local}:${user}:${node}:${codex}`);
});

test('existing caller-selected Node and Codex retain precedence', t => {
  const f = fixture(t);
  const chosen = f.tool('chosen/bin', 'node');
  f.tool('chosen/bin', 'codex');
  f.tool('opt/homebrew/opt/node@24/bin', 'node');
  f.tool('Applications/Codex.app/Contents/Resources', 'codex');
  f.tool('user home/.nvm/versions/node/v99.0.0/bin', 'node');
  const result = f.run(`${chosen}:/usr/bin:/bin`);
  assert.ok(result[0].startsWith(`${chosen}:/usr/bin:/bin:`));
  assert.equal(result[1], `${chosen}/node`);
  assert.equal(result[2], `${chosen}/codex`);
  assert.equal(result[0].includes('/.nvm/'), false);
});

test('missing paths, unmatched globs, and bundles without an executable are omitted', t => {
  const f = fixture(t);
  f.dir('opt/homebrew/opt/node@28/bin');
  f.tool('usr/local/opt/node@20/bin', 'node', false);
  f.tool('Applications/Codex.app/Contents/Resources', 'codex', false);
  assert.deepEqual(f.run(), ['/usr/bin:/bin']);
});

test('unversioned Homebrew Node and real-user desktop bundles work with a repointed HOME', t => {
  const f = fixture(t);
  const node = f.tool('usr/local/opt/node/bin', 'node');
  const codex = f.tool('real user/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS', 'codex');
  const result = f.run(undefined, '', { JOB_QUEST_SYSTEM_HOME: path.join(f.root, 'real user') });
  assert.deepEqual(result, [`/usr/bin:/bin:${node}:${codex}`, `${node}/node`, `${codex}/codex`]);
});

test('nvm remains a fallback when no earlier Node is available', t => {
  const f = fixture(t);
  f.tool('user home/.nvm/versions/node/v20.0.0/bin', 'node');
  const node = f.tool('user home/.nvm/versions/node/v24.1.0/bin', 'node');
  assert.deepEqual(f.run(), [`${node}:/usr/bin:/bin`, `${node}/node`]);
});

test('PATH membership uses whole entries and an empty PATH gains no current-directory entry', t => {
  const f = fixture(t);
  const brew = f.dir('opt/homebrew/bin');
  const initial = `${brew}-other:/usr/bin:/bin`;
  assert.equal(f.run(initial)[0], `${initial}:${brew}`);
  assert.deepEqual(f.run(''), [brew]);
});
