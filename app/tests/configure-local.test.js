const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'skill/bin/configure-local.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-local-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  const brief = path.join(dir, 'brief.json');
  const queue = path.join(dir, 'queue.json');
  const interview = path.join(dir, 'interview');
  fs.writeFileSync(brief, JSON.stringify({ sources: [], opportunities: [] }));
  fs.writeFileSync(queue, JSON.stringify({ items: [], holds: [] }));
  fs.mkdirSync(interview);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, DATA_DIR: data }, encoding: 'utf8', timeout: 5000,
  });
  return { dir, data, brief, queue, interview, run, file: path.join(data, 'local-setup.json') };
}

test('optional local configuration records explicit paths without installing a schedule', t => {
  const f = fixture(t);
  const result = f.run('--career-brief', f.brief, '--reply-queue', f.queue, '--interview-home', f.interview, '--external-schedule');
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(saved, { careerBrief: f.brief, replyQueue: f.queue, interviewHome: f.interview, schedule: 'external' });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(f.data).length, 1);
});

test('local-only removes remote access while preserving brief, queue and interview selection', t => {
  const f = fixture(t);
  assert.equal(f.run('--career-brief', f.brief, '--reply-queue', f.queue, '--interview-home', f.interview,
    '--private-origin', 'https://device.example.ts.net', '--tailscale-user', 'person@example.com').status, 0);
  assert.equal(f.run('--local-only').status, 0);
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(saved.careerBrief, f.brief);
  assert.equal(saved.replyQueue, f.queue);
  assert.equal(saved.interviewHome, f.interview);
  assert.equal(saved.privateOrigin, undefined);
  assert.equal(saved.tailscaleUser, undefined);
});

test('invalid input leaves the previous private setup untouched', t => {
  const f = fixture(t);
  assert.equal(f.run('--career-brief', f.brief).status, 0);
  const before = fs.readFileSync(f.file, 'utf8');
  const bad = f.run('--interview-home', path.join(f.dir, 'missing'));
  assert.equal(bad.status, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.writeFileSync(f.queue, JSON.stringify({ items: [] }));
  assert.equal(f.run('--reply-queue', f.queue).status, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('source installer includes the documented local configurator command', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(installer, /cp "\$APP_DIR\/skill\/bin\/configure-local\.cjs" "\$BIN_DIR\/configure-local\.cjs"/);
  assert.match(installer, /chmod \+x "\$BIN_DIR\/configure-local\.cjs"/);
});
