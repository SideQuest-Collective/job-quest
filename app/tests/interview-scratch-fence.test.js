const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildCheatsheet } = require('../lib/interview/cheatsheet');
const { analyzeDebrief } = require('../lib/interview/analysis');
const { seedWorkbook } = require('./helpers/interview-env');

const SCRIPT = path.resolve(__dirname, '../../skill/bin/run-agent.sh');
const HAS_SANDBOX = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

function fixture(t, relativeCwd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-interview-fence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data with spaces');
  const interviewRoot = path.join(dataDir, 'interview-work');
  const cwd = path.join(dataDir, relativeCwd);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(interviewRoot, { recursive: true });
  const target = path.join(interviewRoot, 'sessions', 'other-role', 'protected.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'other role');
  fs.symlinkSync(path.dirname(target), path.join(cwd, 'other-role-link'));
  const prompt = path.join(cwd, 'prompt.md');
  fs.writeFileSync(prompt, 'test');
  const fake = path.join(root, 'fake-cli');
  fs.writeFileSync(fake, `#!/bin/bash
printf accepted > accepted.md
if printf clobbered > "$FENCE_TARGET"; then echo target=allowed; else echo target=denied; fi
if printf clobbered > other-role-link/protected.md; then echo symlink=allowed; else echo symlink=denied; fi
if printf root > "$FENCE_ROOT/root-write.md"; then echo root=allowed; else echo root=denied; fi
printf runtime > "$FAKE_RUNTIME_STATE"
`);
  fs.chmodSync(fake, 0o755);
  return { root, cwd, dataDir, interviewRoot, target, prompt, fake };
}

function runtimeEnv(f, runtime = 'claude') {
  return {
    JOB_QUEST_AGENT_RUNTIME_OVERRIDE: runtime,
    JOB_QUEST_RUNTIME_COMMAND: f.fake,
    JOB_QUEST_RUNTIME_DRY_RUN: '0',
    FENCE_TARGET: f.target,
    FENCE_ROOT: f.interviewRoot,
    FAKE_RUNTIME_STATE: path.join(f.root, 'runtime-state'),
  };
}

function run(f, profile = 'write', { dataDir = true, runtime = 'claude' } = {}) {
  const env = { ...process.env, ...runtimeEnv(f, runtime), DATA_DIR: f.dataDir };
  if (!dataDir) delete env.DATA_DIR;
  return spawnSync('bash', [SCRIPT, profile, f.prompt, f.cwd], {
    encoding: 'utf8',
    env,
  });
}

for (const relativeCwd of ['interview-work/cheatsheets/role-a', 'interview-work/sessions/session-a']) {
  test(`interview scratch fence resolves a symlink cwd without DATA_DIR for ${relativeCwd}`, { skip: !HAS_SANDBOX }, (t) => {
    const f = fixture(t, relativeCwd);
    const alias = path.join(f.root, 'work-alias');
    fs.symlinkSync(f.cwd, alias);
    f.cwd = alias;
    for (const runtime of ['claude', 'codex']) {
      const result = run(f, 'write', { dataDir: false, runtime });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(f.target, 'utf8'), 'other role', result.stderr);
      assert.match(result.stdout, /target=denied/);
      assert.match(result.stdout, /symlink=denied/);
      assert.match(result.stdout, /root=denied/);
      assert.equal(fs.readFileSync(path.join(f.cwd, 'accepted.md'), 'utf8'), 'accepted');
      assert.equal(fs.readFileSync(path.join(f.root, 'runtime-state'), 'utf8'), 'runtime');
    }
  });
}

for (const caller of ['buildCheatsheet', 'analyzeDebrief']) {
  test(`${caller} forwards DATA_DIR and fences the real runner when the parent has no DATA_DIR`, { skip: !HAS_SANDBOX }, async (t) => {
    const isCheatsheet = caller === 'buildCheatsheet';
    const f = fixture(t, isCheatsheet ? 'interview-work/cheatsheets/role-a' : 'interview-work/sessions/session-a');
    const output = isCheatsheet
      ? [{ title: 'Card', category: 'intro', bullets: ['One', 'Two', 'Three', 'Four'] }]
      : { asked: [], weakSpots: [], followUps: [] };
    fs.appendFileSync(f.fake, `printf '%s' "\${DATA_DIR-unset}" > data-dir.txt
cat > ${isCheatsheet ? 'cheatsheet.out.json' : 'analysis.json'} <<'JSON'
${JSON.stringify(output)}
JSON
`);
    const env = { ...runtimeEnv(f), DATA_DIR: undefined, JOB_QUEST_FAKE_AGENT: undefined };
    for (const [key, value] of Object.entries(env)) {
      const previous = process.env[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
      t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const result = isCheatsheet
      ? await buildCheatsheet({ dataDir: f.dataDir, roleId: 'role-a', workbookId: seedWorkbook(f.dataDir).id })
      : await analyzeDebrief({ dataDir: f.dataDir, sessionDir: f.root,
        parsed: { folder: 'session-a', round: 'coding', startedAt: '2026-03-14T12:00:00Z', questions: [] } });
    if (isCheatsheet) assert.equal(result.ok, true, result.error);
    else assert.deepEqual(result.analysis, output, result.error);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'data-dir.txt'), 'utf8'), path.resolve(f.dataDir));
    assert.equal(process.env.DATA_DIR, undefined);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'other role');
    assert.equal(fs.existsSync(path.join(f.interviewRoot, 'root-write.md')), false);
    assert.match(fs.readFileSync(path.join(f.cwd, 'agent.log'), 'utf8'), /target=denied[\s\S]*symlink=denied[\s\S]*root=denied/);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'accepted.md'), 'utf8'), 'accepted');
  });
}

for (const relativeCwd of ['interview-work/cheatsheets/role-a', 'interview-work/sessions/session-a', 'interview-work/sessions/drafts']) {
  test(`interview scratch fence protects other work from ${relativeCwd}`, { skip: !HAS_SANDBOX }, (t) => {
    const f = fixture(t, relativeCwd);
    for (const profile of ['write', 'edit']) {
      const result = run(f, profile);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(f.cwd, 'accepted.md'), 'utf8'), 'accepted');
      assert.equal(fs.readFileSync(f.target, 'utf8'), 'other role', result.stderr);
      assert.match(result.stdout, /target=denied/);
      assert.match(result.stdout, /symlink=denied/);
      assert.match(result.stdout, /root=denied/);
      assert.equal(fs.existsSync(path.join(f.interviewRoot, 'root-write.md')), false);
      assert.equal(fs.readFileSync(path.join(f.root, 'runtime-state'), 'utf8'), 'runtime');
    }
  });
}

for (const relativeCwd of ['unrelated/role-a', 'interview-work-other/sessions/role-a']) {
  test(`interview scratch fence leaves unrelated cwd ${relativeCwd} unchanged`, { skip: !HAS_SANDBOX }, (t) => {
    const f = fixture(t, relativeCwd);
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /target=allowed/);
    assert.match(result.stdout, /symlink=allowed/);
    assert.match(result.stdout, /root=allowed/);
  });
}

for (const scratch of ['drafts', 'research']) {
  test(`existing workbook ${scratch} fence still protects its parent`, { skip: !HAS_SANDBOX }, (t) => {
    const f = fixture(t, `workbook/${scratch}`);
    f.target = path.join(f.dataDir, 'workbook', 'progress.json');
    fs.writeFileSync(f.target, 'learner progress');
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /target=denied/);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'learner progress');
    assert.equal(fs.readFileSync(path.join(f.cwd, 'accepted.md'), 'utf8'), 'accepted');
  });
}
