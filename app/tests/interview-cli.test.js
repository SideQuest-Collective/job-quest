const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  makeEnv, copyFixtureSession, setSessionFields, seedRole, seedWorkbook,
  installFakeAnalyst, FAKE_AGENT, ROLE_KEY, FIXTURE_FOLDER,
} = require('./helpers/interview-env');

const REPO = path.resolve(__dirname, '..', '..');
const JQ = path.join(REPO, 'skill', 'bin', 'jq');
const VERSION = require('../package.json').version;

function run(env, args, { script = JQ, extraEnv = {}, omitDataDir = false } = {}) {
  const spawnedEnv = {
    PATH: process.env.PATH, HOME: env.root, DATA_DIR: env.dataDir,
    INTERVIEW_HOME: env.interviewHome, JOB_QUEST_HOME: env.jobQuestHome,
    JOB_QUEST_FAKE_AGENT: FAKE_AGENT, ...extraEnv,
  };
  if (omitDataDir) delete spawnedEnv.DATA_DIR;
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf-8', timeout: 30000,
    env: spawnedEnv,
  });
  assert.ifError(r.error);
  assert.equal(r.stderr, '', `stderr for ${args.join(' ')}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one JSON value on stdout');
  return { code: r.status, json: JSON.parse(lines[0]), stderr: r.stderr };
}

function setup(t) {
  const env = makeEnv();
  env.jobQuestHome = path.join(env.root, '.job-quest');
  fs.mkdirSync(env.jobQuestHome, { recursive: true });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));
  seedRole(env.dataDir, 'applied', { url: '' }); // Never fetch a posting over the network.
  copyFixtureSession(env.interviewHome);
  installFakeAnalyst(env.dataDir);
  return env;
}

function installApp(checkout) {
  const app = path.join(checkout, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.symlinkSync(path.join(REPO, 'app', 'lib'), path.join(app, 'lib'));
  fs.copyFileSync(path.join(REPO, 'app', 'package.json'), path.join(app, 'package.json'));
  return app;
}

test('jq is executable and has a node shebang', () => {
  assert.ok(fs.statSync(JQ).mode & 0o111);
  assert.ok(fs.readFileSync(JQ, 'utf-8').startsWith('#!/usr/bin/env node\n'));
});

test('version prints the app version and the contract', (t) => {
  const r = run(setup(t), ['version']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { version: VERSION, contract: 'jq-interview/1' });
});

test('roles lists matches with the documented fields', (t) => {
  const r = run(setup(t), ['roles', '--company', 'ACME']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, [{ roleKey: ROLE_KEY, company: 'Acme Capital', role: 'Software Engineer', stage: 'applied', hasWorkbook: false, hasTailoredResume: false }]);
});

test('interview-context returns written, skipped, cheatsheet, practice', (t) => {
  const env = setup(t);
  const r = run(env, ['interview-context', ROLE_KEY, '--round', 'coding', '--no-agent']);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json), ['written', 'skipped', 'cheatsheet', 'practice']);
  assert.ok(r.json.written.includes(path.join(env.interviewHome, 'context', 'target.md')));
  assert.ok(r.json.skipped.some((s) => s.reason === 'no-workbook'));
  assert.equal(r.json.cheatsheet, null);
  assert.equal(r.json.practice, null);
});

test('interview-context accepts an empty round and preserves separators in the role', (t) => {
  const env = setup(t);
  const roleKey = 'Acme Capital|Software Engineer | Platform';
  fs.writeFileSync(path.join(env.dataDir, 'role-tracker.json'), JSON.stringify({
    [roleKey]: { stage: 'applied', url: '' },
  }));
  const r = run(env, ['interview-context', roleKey, '--round=', '--no-agent']);
  assert.equal(r.code, 0);
  assert.equal(r.json.practice, null);
  assert.match(fs.readFileSync(path.join(env.interviewHome, 'context', 'target.md'), 'utf8'),
    /Software Engineer \| Platform/);
});

test('interview-context preserves target cheatsheet and reports written, alternate, or blocked practice', (t) => {
  const env = setup(t);
  seedWorkbook(env.dataDir);
  const cheatsheet = path.join(env.interviewHome, 'cheatsheets', 'acme-capital.json');
  const practice = path.join(env.interviewHome, 'practice', 'acme-capital-software-engineer.json');
  const alternate = practice.replace(/\.json$/, '.jq.json');
  fs.mkdirSync(path.dirname(cheatsheet), { recursive: true });
  fs.writeFileSync(cheatsheet, '{"mine":true}');
  const args = ['interview-context', ROLE_KEY, '--round=coding', '--no-agent'];
  const written = run(env, args);
  assert.equal(written.code, 0);
  assert.equal(written.json.cheatsheet, cheatsheet);
  assert.equal(written.json.practice, practice);
  assert.ok(written.json.written.includes(practice));
  fs.writeFileSync(practice, '{"mine":true}');
  const sibling = run(env, args);
  assert.equal(sibling.code, 0);
  assert.equal(sibling.json.cheatsheet, cheatsheet);
  assert.equal(sibling.json.practice, alternate);
  assert.ok(sibling.json.skipped.some((s) => s.path === practice && s.wroteInstead === alternate));
  fs.writeFileSync(alternate, '{"alsoMine":true}');
  const blocked = run(env, args);
  assert.equal(blocked.code, 0);
  assert.equal(blocked.json.cheatsheet, cheatsheet);
  assert.equal(blocked.json.practice, null);
  assert.ok(blocked.json.skipped.some((s) => s.path === practice && s.siblingUserOwned && s.wroteInstead === null));
  assert.equal(fs.readFileSync(cheatsheet, 'utf8'), '{"mine":true}');
  assert.equal(fs.readFileSync(practice, 'utf8'), '{"mine":true}');
  assert.equal(fs.readFileSync(alternate, 'utf8'), '{"alsoMine":true}');
});

test('ingest-session, link-session, then ingest-session again', (t) => {
  const env = setup(t);
  const a = run(env, ['ingest-session', FIXTURE_FOLDER]);
  assert.equal(a.code, 0);
  assert.equal(a.json.status, 'unlinked');
  const b = run(env, ['link-session', FIXTURE_FOLDER, ROLE_KEY]);
  assert.equal(b.code, 0);
  assert.equal(b.json.status, 'ingested');
  assert.deepEqual(Object.keys(b.json), ['status', 'folder', 'effects', 'summary']);
  assert.equal(b.json.folder, FIXTURE_FOLDER);
  assert.deepEqual(Object.keys(b.json.effects), ['timeline', 'stage', 'workbookQids', 'tasks', 'progress']);
  assert.equal(typeof b.json.summary, 'string');
  assert.ok(!b.json.summary.includes('\n'));
  const c = run(env, ['ingest-session', path.join(env.interviewHome, 'sessions', FIXTURE_FOLDER)]);
  assert.equal(c.code, 0);
  assert.equal(c.json.status, 'unchanged');
});

test('link-session accepts a role containing another separator through the CLI', (t) => {
  const env = setup(t);
  const roleKey = 'Acme Capital|Software Engineer | Platform';
  fs.writeFileSync(path.join(env.dataDir, 'role-tracker.json'), JSON.stringify({
    [roleKey]: { stage: 'applied', url: '' },
  }));
  const result = run(env, ['link-session', FIXTURE_FOLDER, roleKey]);
  assert.equal(result.code, 0);
  assert.equal(result.json.status, 'ingested');
  assert.match(result.json.summary, /Software Engineer \| Platform/);
});

test('ingest-session refuses a symlink by name and absolute path with an input-error exit', (t) => {
  const env = setup(t);
  const name = 'session-alias';
  const alias = path.join(env.interviewHome, 'sessions', name);
  fs.symlinkSync(path.join(env.interviewHome, 'sessions', FIXTURE_FOLDER), alias);
  for (const folder of [name, alias]) {
    const r = run(env, ['ingest-session', folder]);
    assert.equal(r.code, 2, folder);
    assert.deepEqual(Object.keys(r.json), ['error']);
    assert.match(r.json.error, /session folder must not be a symlink/);
  }
  assert.equal(fs.existsSync(path.join(env.dataDir, 'interview-sessions', `${name}.json`)), false);
});

test('usage errors exit 2, runtime errors exit 1, both with {"error"} on stdout', (t) => {
  const env = setup(t);
  const cases = [
    [['frobnicate'], 2, /^unknown command: frobnicate; run jq with no arguments for usage$/],
    [[], 2, /usage: jq/],
    [['roles'], 2, /roles needs --company/],
    [['roles', '--company', '!!!'], 2, /roles needs --company/],
    [['link-session', FIXTURE_FOLDER], 2, /link-session needs <folder> <roleKey>/],
    [['interview-context', ROLE_KEY, '--round'], 2, /--round needs a value/],
    [['link-session', FIXTURE_FOLDER, 'Nobody|Role'], 2, /unknown roleKey: Nobody\|Role/],
    [['link-session', FIXTURE_FOLDER, 'bad-role'], 2, /roleKey must look like/],
    [['interview-context', 'bad-role'], 2, /roleKey must look like/],
    [['ingest-session', '../bad'], 2, /invalid session folder name/],
    [['ingest-session', '2020-01-01_0000'], 1, /session folder not found/],
    [['interview-context', ROLE_KEY, '--round', 'lunch'], 2, /round must be one of/],
  ];
  for (const [args, code, re] of cases) {
    const r = run(env, args);
    assert.equal(r.code, code, args.join(' '));
    assert.deepEqual(Object.keys(r.json), ['error'], args.join(' '));
    assert.match(r.json.error, re, args.join(' '));
  }
  setSessionFields(path.join(env.interviewHome, 'sessions', FIXTURE_FOLDER), { contractVersion: 'jq-interview/2\nprivate detail' });
  const m = run(env, ['ingest-session', FIXTURE_FOLDER]);
  assert.equal(m.code, 1);
  assert.deepEqual(m.json, { error: 'contract mismatch: session 2026-03-14_0930 uses jq-interview/2' });
});

test('rejects undocumented flags, boolean values, and extra positional arguments', (t) => {
  const env = setup(t);
  for (const args of [
    ['version', 'extra'], ['version', '--company', 'Acme'],
    ['roles', '--company', 'Acme', 'extra'], ['roles', '--unknown', 'value'],
    ['interview-context', ROLE_KEY, '--no-agent=false'],
    ['interview-context', ROLE_KEY, '--unknown', 'value'],
    ['ingest-session', FIXTURE_FOLDER, '--round', 'coding'],
    ['link-session', FIXTURE_FOLDER, ROLE_KEY, 'extra'],
  ]) {
    const r = run(env, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.deepEqual(Object.keys(r.json), ['error']);
  }
});

test('works from installed symlink, copied bin, and JOB_QUEST_APP_DIR layouts', (t) => {
  const env = setup(t);
  const bin = path.join(env.jobQuestHome, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const installed = path.join(bin, 'jq');
  fs.symlinkSync(JQ, installed);
  assert.equal(run(env, ['version'], { script: installed }).json.contract, 'jq-interview/1');
  const copy = path.join(env.root, 'copied-jq');
  fs.copyFileSync(JQ, copy);
  const checkout = path.join(env.root, 'checkout');
  installApp(checkout);
  assert.equal(run(env, ['version'], { script: copy, extraEnv: { JOB_QUEST_APP_DIR: checkout } }).json.contract, 'jq-interview/1');
  fs.unlinkSync(installed);
  fs.copyFileSync(JQ, installed);
  installApp(path.join(env.jobQuestHome, 'app'));
  assert.equal(run(env, ['version'], { script: installed }).json.contract, 'jq-interview/1');
  for (const extraEnv of [{}, { JOB_QUEST_APP_DIR: path.join(env.root, 'missing') }]) {
    const lost = run(env, ['version'], { script: copy, extraEnv });
    assert.equal(lost.code, 1);
    assert.match(lost.json.error, /Job Quest app not found/);
  }
});

test('DATA_DIR takes precedence over app .env', (t) => {
  const env = setup(t);
  const checkout = path.join(env.root, 'checkout');
  const app = installApp(checkout);
  const fromFile = path.join(env.root, 'configured-data');
  fs.mkdirSync(fromFile, { recursive: true });
  seedRole(fromFile, 'interviewing', { url: '' });
  fs.writeFileSync(path.join(app, '.env'), `DATA_DIR=${fromFile}\n`);
  const args = ['roles', '--company=Acme'];
  assert.equal(run(env, args, { extraEnv: { JOB_QUEST_APP_DIR: checkout } }).json[0].stage, 'applied');
});

test('roles reads app .env when DATA_DIR is omitted', (t) => {
  const env = setup(t);
  const checkout = path.join(env.root, 'checkout');
  const app = installApp(checkout);
  const fromFile = path.join(env.root, 'configured-data');
  fs.mkdirSync(fromFile, { recursive: true });
  seedRole(fromFile, 'interviewing', { url: '' });
  fs.writeFileSync(path.join(app, '.env'), `DATA_DIR=${fromFile}\n`);
  const r = run(env, ['roles', '--company', 'Acme'], {
    omitDataDir: true, extraEnv: { JOB_QUEST_APP_DIR: checkout },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, [{ roleKey: ROLE_KEY, company: 'Acme Capital', role: 'Software Engineer', stage: 'interviewing', hasWorkbook: false, hasTailoredResume: false }]);
});

test('roles reads JOB_QUEST_HOME/data when DATA_DIR and app .env are absent', (t) => {
  const env = setup(t);
  const checkout = path.join(env.root, 'checkout');
  const app = installApp(checkout);
  assert.equal(fs.existsSync(path.join(app, '.env')), false);
  const fromHome = path.join(env.jobQuestHome, 'data');
  fs.mkdirSync(fromHome, { recursive: true });
  seedRole(fromHome, 'interviewing', { url: '' });
  const r = run(env, ['roles', '--company', 'Acme'], {
    omitDataDir: true, extraEnv: { JOB_QUEST_APP_DIR: checkout },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, [{ roleKey: ROLE_KEY, company: 'Acme Capital', role: 'Software Engineer', stage: 'interviewing', hasWorkbook: false, hasTailoredResume: false }]);
});
