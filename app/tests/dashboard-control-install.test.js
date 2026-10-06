const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');

test('installer copies executable dashboard controls and their shared helper into the temporary product home', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-dashboard-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, '.job-quest/app');
  const stubs = path.join(home, 'stubs');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'app'));
  fs.mkdirSync(stubs);
  for (const dir of ['skill', 'lib']) fs.cpSync(path.join(ROOT, dir), path.join(repo, dir), { recursive: true });
  for (const [name, body] of Object.entries({
    git: '[ "$*" = pull ]', npm: 'exit 0', uname: 'echo Linux',
    node: '[ "$1" != -v ] || echo v22.0.0; exit 0',
  })) fs.writeFileSync(path.join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', [path.join(ROOT, 'install.sh')], {
    env: { HOME: home, JOB_QUEST_RUNTIME: 'codex', PATH: `${stubs}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const file of ['start.sh', 'stop.sh', 'restart.sh', 'uninstall.sh', 'lib/dashboard-control.sh']) {
    const installed = path.join(home, '.job-quest/bin', file);
    assert.ok(fs.existsSync(installed), `installer must copy ${file}`);
    assert.ok(fs.statSync(installed).mode & 0o111, `${file} must be executable`);
    assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(path.join(ROOT, 'skill/bin', file), 'utf8'));
  }
});
