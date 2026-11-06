const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../../skill/bin/run-daily-intel.sh');
const { filterIntel, handledRoles } = require('../lib/jobs/handled-roles-cli');
const UUID = '0b6c1f9e-1111-2222-3333-444455556666';

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// A runner fixture whose fake agent writes today's intel report with handled and new roles.
function runFixture(t, { withHelper = true, history } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-intel-handled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['skill/bin', 'lib', 'data/intel', 'references', 'app/lib/intel-control', 'app/lib/jobs', 'app/lib/interview']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(source, path.join(root, 'skill/bin/run-daily-intel.sh'));
  fs.copyFileSync(path.resolve(__dirname, '../lib/intel-control/lock.js'), path.join(root, 'app/lib/intel-control/lock.js'));
  if (withHelper) for (const name of ['handled-roles-cli.js', 'role-history.js', 'role-identity.js']) fs.copyFileSync(path.resolve(__dirname, '../lib/jobs', name), path.join(root, 'app/lib/jobs', name));
  fs.writeFileSync(path.join(root, 'data/profile.json'), JSON.stringify({ name: 'Fixture', targetCompanies: {} }));
  fs.writeFileSync(path.join(root, 'data/role-actions.json'), JSON.stringify({ saved: [], skipped: ['Acme|Senior Fullstack Engineer'], applied: ['Beta|Staff Engineer'] }));
  fs.writeFileSync(path.join(root, 'data/role-tracker.json'), JSON.stringify({ 'Gamma|Senior SWE': { stage: 'researching' } }));
  if (history) fs.writeFileSync(path.join(root, 'data/role-history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(root, 'data/intel/2026-01-01.json'), JSON.stringify({ date: '2026-01-01', roles: [{ company: 'Beta', role: 'Staff Engineer', url: `https://jobs.ashbyhq.com/beta/${UUID}` }] }));
  fs.writeFileSync(path.join(root, 'references/intel-agent-template.md'), 'Fixture template');
  const today = localDate();
  const report = { date: today, roles: [
    { company: 'Acme Inc', role: 'Sr. Full-Stack Engineer - NYC', url: 'https://acme.example/careers' },
    { company: 'Beta', role: 'Staff Software Engineer', url: `https://jobs.ashbyhq.com/beta/${UUID}/application` },
    { company: 'Delta', role: 'Senior Backend Engineer', url: 'https://job-boards.greenhouse.io/delta/jobs/555555' },
    { company: 'Fresh', role: 'Senior Backend Engineer', url: 'https://jobs.lever.co/fresh/62ac428a-80ef-4469-9e06-0b87ed4f206f' },
  ] };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report));
  fs.writeFileSync(path.join(root, 'lib/runtime-shell.sh'), `job_quest_load_runtime() {\n export JOB_QUEST_ACTIVE_RUNTIME=claude\n export JOB_QUEST_DATA_DIR="$JOB_QUEST_REPO_ROOT/data"\n export JOB_QUEST_REFERENCES_DIR="$JOB_QUEST_REPO_ROOT/references"\n export JOB_QUEST_APP_ROOT="$JOB_QUEST_REPO_ROOT"\n export JOB_QUEST_RUNTIME_COMMAND=claude\n JOB_QUEST_RUNTIME_COMMAND_ARGS=()\n}\njob_quest_runtime_hint() { echo fixture; }\njob_quest_run_prompt_file() {\n cp "$1" "$JOB_QUEST_REPO_ROOT/captured-prompt"\n handled="$(sed -n 's/.*roles listed in \\([^,]*\\), one per line.*/\\1/p' "$1")"\n [ -n "$handled" ] && cp "$handled" "$JOB_QUEST_REPO_ROOT/captured-handled"\n cp "$JOB_QUEST_REPO_ROOT/report.json" "$JOB_QUEST_DATA_DIR/intel/${today}.json"\n echo 'Done: 4 roles'\n}\n`);
  const result = spawnSync('bash', [path.join(root, 'skill/bin/run-daily-intel.sh')], { encoding: 'utf8' });
  const read = name => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : null;
  return { root, result, today, prompt: read('captured-prompt'), handled: read('captured-handled'), intel: JSON.parse(read(`data/intel/${today}.json`)), log: read('data/logs/daily-intel.log') };
}

test('the discovery agent receives the handled list and today\'s report is filtered against it', t => {
  const run = runFixture(t, { history: { version: 1, events: [
    { key: 'Delta|Senior Back-End Engineer', company: 'Delta', title: 'Senior Back-End Engineer', url: 'https://job-boards.greenhouse.io/embed/job_app?for=delta&token=555555', action: 'save', source: 'discover' },
    { key: 'Undone|Role', company: 'Undone', title: 'Role', action: 'skip', source: 'discover', undoneAt: '2026-11-05T00:00:00Z' },
  ] } });
  assert.equal(run.result.status, 0, run.result.stderr);
  const dedupe = run.prompt.split('## Deduplication')[1].split('## Variety')[0];
  assert.match(dedupe, /already handled \(skipped, saved, applied to or tracked\) the 4 roles listed in/);
  assert.match(dedupe, /do not report any of those roles again/);
  assert.match(run.handled, /^Acme \| Senior Fullstack Engineer \| -$/m);
  assert.match(run.handled, new RegExp(`^Beta \\| Staff Engineer \\| https://jobs\\.ashbyhq\\.com/beta/${UUID}$`, 'm'));
  assert.match(run.handled, /^Delta \| Senior Back-End Engineer \| https:\/\/job-boards\.greenhouse\.io\/delta\/jobs\/555555$/m);
  assert.match(run.handled, /^Gamma \| Senior SWE \| -$/m);
  assert.doesNotMatch(run.handled, /Undone/, 'undone actions are not handled');
  assert.deepEqual(run.intel.roles.map(role => role.company), ['Fresh']);
  assert.deepEqual(run.intel.suppressedRoles.map(role => [role.company, role.matchedKey, role.suppressedReason]), [
    ['Acme Inc', 'Acme|Senior Fullstack Engineer', 'already-handled'],
    ['Beta', 'Beta|Staff Engineer', 'already-handled'],
    ['Delta', 'Delta|Senior Back-End Engineer', 'already-handled'],
  ]);
  assert.match(run.log, /Handled-role filter on intel\/.*: kept 1, suppressed 3/);
  assert.equal(fs.existsSync(path.join(run.root, 'data/role-history.json')), true);
  assert.equal(fs.readdirSync(path.join(run.root, 'data/logs')).some(name => name.startsWith('handled-roles.')), false, 'temporary list is cleaned up');
  assert.equal(JSON.parse(fs.readFileSync(path.join(run.root, 'data/logs/daily-intel-last-run.json'), 'utf8')).status, 'completed');
});

test('without a ledger the runner seeds in memory only, and a missing helper leaves the runner behaviour unchanged', t => {
  const seeded = runFixture(t);
  assert.equal(seeded.result.status, 0, seeded.result.stderr);
  assert.equal(fs.existsSync(path.join(seeded.root, 'data/role-history.json')), false, 'the runner never creates the ledger');
  assert.deepEqual(seeded.intel.roles.map(role => role.company), ['Delta', 'Fresh']);
  const bare = runFixture(t, { withHelper: false });
  assert.equal(bare.result.status, 0, bare.result.stderr);
  assert.doesNotMatch(bare.prompt, /already handled/);
  assert.equal(bare.intel.roles.length, 4);
  assert.equal(bare.intel.suppressedRoles, undefined);
  assert.match(bare.log, /handled-roles helper missing/);
});

test('filterIntel is a no-op when nothing matches and keeps earlier suppressed roles', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-handled-filter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'role-actions.json'), JSON.stringify({ saved: ['Oscar|Senior Software Engineer'], skipped: [], applied: [] }));
  const file = path.join(dir, 'today.json');
  const report = { date: '2026-11-06', roles: [{ company: 'New', role: 'Engineer' }], suppressedRoles: [{ company: 'Old' }], tips: ['kept'] };
  fs.writeFileSync(file, JSON.stringify(report));
  const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(filterIntel(dir, file).suppressed, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  fs.writeFileSync(file, JSON.stringify({ ...report, roles: [...report.roles, { company: 'Oscar Health', role: 'Sr. Software Engineer' }] }));
  assert.equal(filterIntel(dir, file).suppressed, 1);
  const next = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(next.tips, ['kept']);
  assert.deepEqual(next.suppressedRoles.map(role => role.company), ['Old', 'Oscar Health']);
  assert.equal(handledRoles(dir).length, 1);
});
