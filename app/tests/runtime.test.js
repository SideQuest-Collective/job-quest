const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');

function fixture(t, { saved, env = {} }, install) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-runtime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const productHome = path.join(home, '.job-quest');
  const configPath = path.join(productHome, 'config/runtime.json');
  const stubs = path.join(home, 'stubs');
  fs.mkdirSync(stubs);
  fs.symlinkSync(process.execPath, path.join(stubs, 'node'));
  for (const [name, body] of Object.entries({
    git: '[ "$*" = pull ]',
    npm: 'exit 0',
    uname: 'echo Linux',
    claude: 'exit 0',
    codex: 'exit 0',
    // Keep runtime command discovery isolated from system login profiles.
    bash: 'if [ "$1" = -lc ]; then shift; exec /bin/bash -c "$@"; fi\nexec /bin/bash "$@"',
  })) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  if (saved !== undefined) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ activeRuntime: saved }));
  }
  if (install) {
    const repo = path.join(productHome, 'app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'app'));
    for (const dir of ['skill', 'lib']) {
      fs.cpSync(path.join(ROOT, dir), path.join(repo, dir), { recursive: true });
    }
  }
  return {
    configPath,
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...env },
  };
}

const cases = [
  { name: 'saved Claude survives a Codex shell', saved: 'claude', env: { CODEX_THREAD_ID: 'test' }, expected: 'claude' },
  { name: 'saved Codex survives a plain shell', saved: 'codex', expected: 'codex' },
  ...['JOB_QUEST_RUNTIME', 'JOBQUEST_RUNTIME', 'JQ_RUNTIME'].map(key => ({
    name: `explicit ${key} overrides saved Claude`, saved: 'claude', env: { [key]: 'codex' }, expected: 'codex',
  })),
  { name: 'explicit Claude overrides saved Codex and Codex shell', saved: 'codex', env: { JOB_QUEST_RUNTIME: 'claude', CODEX_THREAD_ID: 'test' }, expected: 'claude' },
  { name: 'first install in a Codex shell selects Codex', env: { CODEX_THREAD_ID: 'test' }, expected: 'codex' },
  { name: 'first install recognizes any CODEX_ variable', env: { CODEX_RUNTIME_TEST: '1' }, expected: 'codex' },
  { name: 'first install in a plain shell selects Claude', expected: 'claude' },
  { name: 'invalid saved runtime falls back to shell detection', saved: 'unsupported', env: { CODEX_THREAD_ID: 'test' }, expected: 'codex' },
];

for (const install of [false, true]) {
  for (const scenario of cases) {
    test(`${install ? 'install.sh' : 'runtime ensure'}: ${scenario.name}`, t => {
      const f = fixture(t, scenario, install);
      const result = spawnSync(install ? '/bin/bash' : process.execPath,
        install ? [path.join(ROOT, 'install.sh')] : [path.join(ROOT, 'lib/runtime.js'), 'ensure'], {
          env: f.env, encoding: 'utf8', timeout: 10000,
        });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
      assert.equal(config.activeRuntime, scenario.expected);
      assert.equal(config.runtimeCommand, scenario.expected);
      assert.equal(config.runtimeValidation.status, 'ready');
      if (install) {
        assert.match(result.stdout, new RegExp(`Active runtime: +${scenario.expected}`));
      } else {
        assert.equal(JSON.parse(result.stdout).activeRuntime, scenario.expected);
      }
    });
  }
}
