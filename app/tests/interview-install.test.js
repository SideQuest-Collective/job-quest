const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const install = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf-8');
const skill = fs.readFileSync(path.join(ROOT, 'skill', 'SKILL.md'), 'utf-8');

test('install.sh symlinks jq into ~/.job-quest/bin and creates the records dir', () => {
  assert.ok(install.includes('ln -sfn "$APP_DIR/skill/bin/jq" "$BIN_DIR/jq"'));
  assert.ok(install.includes('mkdir -p "$DATA_DIR/interview-sessions"'));
  assert.ok(install.indexOf('ln -sfn "$APP_DIR/skill/bin/jq"') > install.indexOf('chmod +x "$BIN_DIR/"*.sh'));
});

test('install.sh never puts ~/.job-quest/bin on PATH', () => {
  assert.equal(/PATH=[^\n]*(BIN_DIR|\.job-quest\/bin)/.test(install), false);
  assert.equal(/(\.zshrc|\.bashrc|\.profile|\.zshenv)/.test(install), false);
});

test('install.sh is valid bash', () => {
  execFileSync('bash', ['-n', path.join(ROOT, 'install.sh')]);
});

test('SKILL.md documents the integration and absolute-path invocation', () => {
  assert.ok(skill.includes('## /interview integration'));
  assert.ok(skill.includes('~/.job-quest/bin/jq'));
  assert.match(skill, /not the `jq` JSON tool/);
});
