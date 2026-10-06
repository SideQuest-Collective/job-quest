'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const installer = path.resolve(__dirname, '../../skill/bin/install-xbar.sh');
const source = path.resolve(__dirname, '../../skill/bin/xbar/job-quest.5m.sh');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-xbar-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stubs = path.join(home, 'stubs');
  const sourceDir = path.join(home, '.job-quest/bin/xbar');
  const app = path.join(home, 'Applications/xbar.app');
  const destination = path.join(home, 'Library/Application Support/xbar/plugins/job-quest.5m.sh');
  fs.mkdirSync(stubs);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.copyFileSync(source, path.join(sourceDir, 'job-quest.5m.sh'));
  fs.writeFileSync(path.join(stubs, 'uname'), '#!/bin/bash\nprintf "Darwin\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'open'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$HOME/open.calls"\n', { mode: 0o755 });
  return {
    home, app, destination,
    run(args = []) {
      const result = spawnSync('/bin/bash', [installer, ...args], {
        env: { ...process.env, HOME: home, PATH: `${stubs}:/usr/bin:/bin`, XBAR_APP: app },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      return result;
    },
  };
}

test('xbar installer with missing overridden app gives brew instructions and fails', t => {
  const f = fixture(t);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /brew install --cask xbar/);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(path.join(f.home, 'open.calls')), false);
});

test('xbar installer copies an executable plugin for a fake app; status and uninstall work', t => {
  const f = fixture(t);
  fs.mkdirSync(f.app, { recursive: true });
  assert.equal(f.run(['--status']).status, 1);
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.ok(fs.statSync(f.destination).mode & 0o111);
  const status = f.run(['--status']);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(`installed: ${f.destination}`));
  assert.match(fs.readFileSync(path.join(f.home, 'open.calls'), 'utf8'), /refreshAllPlugins/);
  const removed = f.run(['--uninstall']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(f.destination), false);
  const missing = f.run(['--status']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /not installed/);
  assert.equal(f.run(['--uninstall']).status, 0);
});
