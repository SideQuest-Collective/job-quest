const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withServer } = require('./helpers/server');
const { getLocalDateStamp } = require('../lib/local-date');

function fixture(t, { installed = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-xbar-status-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'data');
  const interviewHome = path.join(home, 'interview');
  fs.mkdirSync(dataDir);
  if (installed) {
    fs.mkdirSync(path.join(interviewHome, 'app'), { recursive: true });
    fs.writeFileSync(path.join(interviewHome, 'app', 'capture.py'), '');
  }
  const write = (name, value) => {
    const file = path.join(dataDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const today = getLocalDateStamp();
  const seed = () => {
    write(`tasks/${today}.json`, { date: today, tasks: [{ completed: true }, { completed: false }] });
    write(`intel/${today}.json`, { date: today, roles: [{ company: 'One' }, { company: 'Two' }] });
    write(`quizzes/${today}.json`, { date: today, questions: [{}, {}, {}] });
    write('progress.json', { quizResults: { [today]: [{ isCorrect: true }, { isCorrect: false }] } });
    write('role-actions.json', { saved: ['one', 'two'], applied: ['one'] });
    for (const [index, status] of ['unlinked', 'ingested', 'unlinked', 'failed'].entries()) {
      write(`interview-sessions/session-${index}.json`, { folder: `session-${index}`, status });
    }
    fs.writeFileSync(path.join(dataDir, 'interview-sessions', 'corrupt.json'), '{');
  };
  const run = (fn) => withServer(dataDir, fn, {
    HOME: home, DATA_DIR: dataDir, INTERVIEW_HOME: interviewHome,
    JOB_QUEST_HOME: path.join(home, '.job-quest'),
  });
  return { dataDir, today, write, seed, run };
}

async function status(base) {
  const response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().flatMap((name) => {
    const file = path.join(dir, name);
    return fs.statSync(file).isDirectory()
      ? snapshot(file).map(([relative, contents]) => [`${name}/${relative}`, contents])
      : [[name, fs.readFileSync(file, 'utf8')]];
  });
}

test('/api/status preserves dashboard metrics and counts unlinked records without writes', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run(async (base) => {
    const before = snapshot(f.dataDir);
    const result = await status(base);
    assert.equal(result.ok, true);
    assert.equal(result.date, f.today);
    assert.equal(result.intelDate, f.today);
    assert.equal(result.intelIsToday, true);
    assert.equal(result.rolesToday, 2);
    assert.deepEqual(result.tasks, { done: 1, total: 2 });
    assert.deepEqual(result.quiz, { answered: 2, correct: 1, total: 3 });
    assert.deepEqual(result.roles, { saved: 2, applied: 1 });
    assert.equal(result.streak, 1);
    assert.deepEqual(result.interview, { unlinked: 2 });
    assert.deepEqual(snapshot(f.dataDir), before);
  });
});

test('/api/status exposes stable server pid, start time and package version', async (t) => {
  const f = fixture(t);
  const beforeStart = Date.now();
  await f.run(async (base) => {
    const result = await status(base);
    assert.ok(result.server);
    assert.ok(Number.isInteger(result.server.pid) && result.server.pid > 0);
    assert.notEqual(result.server.pid, process.pid);
    assert.equal(result.server.version, require('../package.json').version);
    assert.ok(Date.parse(result.server.startedAt) >= beforeStart);
    assert.ok(Date.parse(result.server.startedAt) <= Date.now());
    assert.deepEqual((await status(base)).server, result.server);
  });
});

test('/api/status returns zero unlinked when interview is not installed even with stale records', async (t) => {
  const f = fixture(t, { installed: false });
  f.seed();
  await f.run(async (base) => assert.deepEqual((await status(base)).interview, { unlinked: 0 }));
});

test('/api/status defaults missing files to zero and null', async (t) => {
  const f = fixture(t, { installed: false });
  await f.run(async (base) => {
    const result = await status(base);
    assert.equal(result.ok, true);
    assert.equal(result.intelDate, null);
    assert.equal(result.intelIsToday, false);
    assert.equal(result.rolesToday, 0);
    assert.deepEqual(result.tasks, { done: 0, total: 0 });
    assert.deepEqual(result.quiz, { answered: 0, correct: 0, total: 0 });
    assert.deepEqual(result.roles, { saved: 0, applied: 0 });
    assert.equal(result.streak, 0);
    assert.deepEqual(result.interview, { unlinked: 0 });
  });
});

test('/api/status isolates corrupt progress.json and role-actions.json reads', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run(async (base) => {
    for (const contents of ['{', 'null', JSON.stringify({ quizResults: { [f.today]: {} }, saved: 'invalid', applied: {} })]) {
      for (const name of ['progress.json', 'role-actions.json']) {
        fs.writeFileSync(path.join(f.dataDir, name), contents);
      }
      const result = await status(base);
      assert.deepEqual(result.quiz, { answered: 0, correct: 0, total: 3 });
      assert.deepEqual(result.roles, { saved: 0, applied: 0 });
      assert.deepEqual(result.tasks, { done: 1, total: 2 });
      assert.equal(result.rolesToday, 2);
    }
  });
});

for (const directory of ['tasks', 'intel', 'quizzes', 'interview-sessions']) {
  test(`/api/status isolates an unreadable ${directory} directory`, async (t) => {
    const f = fixture(t);
    f.seed();
    await f.run(async (base) => {
      fs.rmSync(path.join(f.dataDir, directory), { recursive: true });
      fs.writeFileSync(path.join(f.dataDir, directory), 'not a directory');
      const result = await status(base);
      assert.deepEqual(result.tasks, directory === 'tasks' ? { done: 0, total: 0 } : { done: 1, total: 2 });
      assert.equal(result.streak, directory === 'tasks' ? 0 : 1);
      assert.equal(result.intelDate, directory === 'intel' ? null : f.today);
      assert.equal(result.rolesToday, directory === 'intel' ? 0 : 2);
      assert.equal(result.quiz.total, directory === 'quizzes' ? 0 : 3);
      assert.deepEqual(result.interview, { unlinked: directory === 'interview-sessions' ? 0 : 2 });
      assert.deepEqual(result.roles, { saved: 2, applied: 1 });
    });
  });
}

test('/api/status tolerates malformed daily data collections and null entries', async (t) => {
  const f = fixture(t);
  f.seed();
  await f.run(async (base) => {
    f.write(`tasks/${f.today}.json`, { date: f.today, tasks: {} });
    f.write(`intel/${f.today}.json`, { date: {}, roles: 'invalid' });
    f.write(`quizzes/${f.today}.json`, { date: f.today, questions: {} });
    let result = await status(base);
    assert.deepEqual(result.tasks, { done: 0, total: 0 });
    assert.equal(result.streak, 0);
    assert.equal(result.intelDate, null);
    assert.equal(result.rolesToday, 0);
    assert.equal(result.quiz.total, 0);
    f.write(`tasks/${f.today}.json`, { date: f.today, tasks: [null, { completed: true }] });
    f.write('progress.json', { quizResults: { [f.today]: [null, { isCorrect: true }] } });
    result = await status(base);
    assert.equal(result.tasks.done, 1);
    assert.equal(result.quiz.correct, 1);
  });
});
