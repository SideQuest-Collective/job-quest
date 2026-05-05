const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { getLocalDateStamp } = require('../lib/local-date');

function writeJson(baseDir, subdir, filename, data) {
  const dir = path.join(baseDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

async function waitForServer(port, child) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/runtime`);
      if (response.ok) return baseUrl;
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`server did not start on port ${port}`);
}

async function withServer(dataDir, runAssertions) {
  const port = 3900 + Math.floor(Math.random() * 500);
  const appDir = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const baseUrl = await waitForServer(port, child);
    await runAssertions(baseUrl);
  } catch (error) {
    error.message = `${error.message}\n${stderr}`.trim();
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 1000);
    });
  }
}

test('daily endpoints use the same local-day artifacts when today exists', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'job-quest-daily-state-'));
  const today = getLocalDateStamp();
  const older = '2026-01-01';

  writeJson(tempRoot, 'intel', `${today}.json`, { date: today, roles: [{ company: 'Today Co' }, { company: 'Later Co' }] });
  writeJson(tempRoot, 'intel', `${older}.json`, { date: older, roles: [{ company: 'Old Co' }] });
  writeJson(tempRoot, 'quizzes', `${today}.json`, { date: today, questions: [{ question: 'Q1' }, { question: 'Q2' }] });
  writeJson(tempRoot, 'quizzes', `${older}.json`, { date: older, questions: [{ question: 'Old quiz' }] });
  writeJson(tempRoot, 'tasks', `${today}.json`, { date: today, tasks: [{ text: 'Task 1', completed: false }] });
  writeJson(tempRoot, 'tasks', `${older}.json`, { date: older, tasks: [{ text: 'Old task', completed: true }] });

  await withServer(tempRoot, async (baseUrl) => {
    const [intel, quiz, tasks, status] = await Promise.all([
      fetch(`${baseUrl}/api/intel/latest`).then((response) => response.json()),
      fetch(`${baseUrl}/api/quizzes/today`).then((response) => response.json()),
      fetch(`${baseUrl}/api/tasks/today`).then((response) => response.json()),
      fetch(`${baseUrl}/api/job-status`).then((response) => response.json()),
    ]);

    assert.equal(intel.date, today);
    assert.equal(quiz.date, today);
    assert.equal(tasks.date, today);
    assert.equal(status.date, today);
    assert.equal(status.status, 'success');
    assert.deepEqual(status.intel, { ready: true, roles: 2 });
    assert.deepEqual(status.quiz, { ready: true, questions: 2 });
    assert.deepEqual(status.tasks, { ready: true, count: 1 });
  });
});

test('code runner supports class-based operation test cases', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'job-quest-code-runner-'));
  const code = `class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.cache = {}

    def get(self, key):
        if key not in self.cache:
            return -1
        value = self.cache.pop(key)
        self.cache[key] = value
        return value

    def put(self, key, value):
        if key in self.cache:
            self.cache.pop(key)
        elif len(self.cache) >= self.capacity:
            oldest = next(iter(self.cache))
            self.cache.pop(oldest)
        self.cache[key] = value
`;

  await withServer(tempRoot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/run-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        functionName: 'LRUCache',
        testCases: [
          {
            input: {
              capacity: 2,
              operations: [
                ['put', 1, 1],
                ['put', 2, 2],
                ['get', 1],
                ['put', 3, 3],
                ['get', 2],
                ['put', 4, 4],
                ['get', 1],
                ['get', 3],
                ['get', 4],
              ],
            },
            expected: [null, null, 1, null, -1, null, -1, 3, 4],
          },
        ],
      }),
    }).then((res) => res.json());

    assert.equal(response.error, undefined);
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0].passed, true);
  });
});

test('fallback endpoints return the newest available artifact when today is missing', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'job-quest-daily-fallback-'));
  const newest = '2026-04-22';
  const older = '2026-04-21';

  writeJson(tempRoot, 'intel', `${newest}.json`, { date: newest, roles: [{ company: 'Newest Co' }] });
  writeJson(tempRoot, 'intel', `${older}.json`, { date: older, roles: [{ company: 'Older Co' }] });
  writeJson(tempRoot, 'quizzes', `${newest}.json`, { date: newest, questions: [{ question: 'Newest quiz' }] });
  writeJson(tempRoot, 'tasks', `${newest}.json`, { date: newest, tasks: [{ text: 'Newest task', completed: false }] });

  await withServer(tempRoot, async (baseUrl) => {
    const [intel, quiz, tasks] = await Promise.all([
      fetch(`${baseUrl}/api/intel/latest`).then((response) => response.json()),
      fetch(`${baseUrl}/api/quizzes/today`).then((response) => response.json()),
      fetch(`${baseUrl}/api/tasks/today`).then((response) => response.json()),
    ]);

    assert.equal(intel.date, newest);
    assert.equal(quiz.date, newest);
    assert.equal(tasks.date, newest);
  });
});

test('system design topics include prep-plan prompts from the role tracker', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'job-quest-sd-prep-topics-'));
  const roleKey = 'Acme|Staff Platform Engineer';

  fs.writeFileSync(path.join(tempRoot, 'role-tracker.json'), JSON.stringify({
    [roleKey]: {
      interviewPlan: {
        systemDesignPrompt: {
          title: 'Design a multi-region metrics ingestion platform',
          description: 'Handle high-volume telemetry ingestion with regional failover.',
          keyTopics: ['partitioning', 'backpressure'],
          evaluationCriteria: ['capacity estimates', 'failure handling'],
        },
        technicalQuestions: [
          {
            question: 'How would you shard the metrics ingestion path?',
            category: 'system-design',
            difficulty: 'hard',
            type: 'text',
            sampleAnswer: 'Discuss tenant-aware partitioning and hot shard mitigation.',
          },
          {
            question: 'Implement a retry helper',
            category: 'coding',
            difficulty: 'medium',
            type: 'code',
          },
        ],
      },
    },
  }, null, 2));

  await withServer(tempRoot, async (baseUrl) => {
    const topics = await fetch(`${baseUrl}/api/sd-topics`).then((response) => response.json());
    const prepTopic = topics.find((topic) => topic.source === 'prep-plan' && topic.sourceRoleKey === roleKey);

    assert.ok(prepTopic);
    assert.match(prepTopic.id, /^prep-[a-f0-9]{12}$/);
    assert.equal(prepTopic.title, 'Design a multi-region metrics ingestion platform');
    assert.equal(prepTopic.sourceCompany, 'Acme');
    assert.equal(prepTopic.sourceRole, 'Staff Platform Engineer');
    assert.deepEqual(prepTopic.keyTopics, ['partitioning', 'backpressure']);
    assert.equal(prepTopic.hasConversation, false);

    const technicalTopic = topics.find((topic) => topic.source === 'prep-plan' && topic.title === 'How would you shard the metrics ingestion path?');
    assert.ok(technicalTopic);
    assert.equal(technicalTopic.sourceRoleKey, roleKey);
    assert.deepEqual(technicalTopic.evaluationCriteria, ['Discuss tenant-aware partitioning and hot shard mitigation.']);

    const conversation = await fetch(`${baseUrl}/api/sd-conversation/${prepTopic.id}`).then((response) => response.json());
    assert.deepEqual(conversation, { messages: [] });
  });
});
