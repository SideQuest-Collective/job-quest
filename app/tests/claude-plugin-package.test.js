// T-0028: Job Quest ships as a Claude Code plugin from this repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const MARKETPLACE_JSON = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'job-quest');
const PLUGIN_JSON = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
const PLUGIN_SKILL = path.join(PLUGIN_DIR, 'skills', 'job-quest', 'SKILL.md');

function readJson(file) {
  assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} must exist`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('repo-root marketplace job-quest-local lists the job-quest plugin from plugins/job-quest', () => {
  const marketplace = readJson(MARKETPLACE_JSON);
  assert.equal(marketplace.name, 'job-quest-local');
  assert.ok(marketplace.owner && typeof marketplace.owner.name === 'string' && marketplace.owner.name, 'marketplace needs owner.name');
  assert.ok(Array.isArray(marketplace.plugins), 'marketplace.plugins must be an array');
  const entries = marketplace.plugins.filter(p => p.name === 'job-quest');
  assert.equal(entries.length, 1, 'exactly one job-quest plugin entry');
  const [entry] = entries;
  assert.equal(typeof entry.source, 'string');
  assert.equal(path.resolve(ROOT, entry.source), PLUGIN_DIR, 'source must point at plugins/job-quest');
  const plugin = readJson(PLUGIN_JSON);
  assert.equal(entry.version, plugin.version, 'marketplace and plugin.json versions must match so updates refresh the cache');
});

test('plugin manifest names job-quest with a semver version and carries the moved skill', () => {
  const plugin = readJson(PLUGIN_JSON);
  assert.equal(plugin.name, 'job-quest');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.ok(fs.existsSync(PLUGIN_SKILL), 'SKILL.md must live at plugins/job-quest/skills/job-quest/SKILL.md');
  const skill = fs.readFileSync(PLUGIN_SKILL, 'utf8');
  assert.match(skill, /^---\nname: job-quest\n/);
  assert.equal(fs.existsSync(path.join(ROOT, 'skill', 'SKILL.md')), false, 'skill/SKILL.md moves; no second copy to drift');
  // Helpers stay in skill/; the plugin cache only needs the manifest and the skill.
  assert.ok(fs.existsSync(path.join(ROOT, 'skill', 'bin', 'start.sh')));
  assert.equal(fs.existsSync(path.join(PLUGIN_DIR, 'bin')), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_DIR, 'node_modules')), false);
});

test('README and validation checklist document the plugin registration', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('job-quest@job-quest-local'), 'README names the plugin id');
  assert.match(readme, /claude plugin/);
  const checklist = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'dual-runtime-checklist.md'), 'utf8');
  assert.ok(checklist.includes('job-quest@job-quest-local'), 'checklist verifies the plugin registration');
});
