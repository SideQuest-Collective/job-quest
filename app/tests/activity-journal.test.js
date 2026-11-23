const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function journalHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-activity-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const block = source.slice(source.indexOf('const ACTIVITY_FILE ='), source.indexOf('// --- Auto-complete daily tasks helper ---'));
  assert.match(block, /function readActivity\(/);
  assert.match(block, /function countActiveDays\(/);
  const api = vm.runInNewContext(`${block}\n({ readActivity, logActivity, countActiveDays })`, {
    fs, path, DATA_DIR: dir, getLocalDateStamp: () => '2026-10-08',
  });
  return { file: path.join(dir, 'activity.json'), ...api };
}

test('writing activity migrates an empty legacy array into a date-keyed journal', t => {
  const h = journalHarness(t);
  fs.writeFileSync(h.file, '[]');
  h.logActivity('quiz_answer', { quizDate: '2026-10-08' });
  const journal = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  assert.equal(Array.isArray(journal), false);
  assert.equal(journal['2026-10-08'].events.length, 1);
  assert.equal(journal['2026-10-08'].events[0].type, 'quiz_answer');
  assert.equal(h.countActiveDays(journal, []), 1);
});

test('unsupported nonempty activity arrays remain untouched', t => {
  const h = journalHarness(t);
  const original = '[{"legacy":"keep"}]';
  fs.writeFileSync(h.file, original);
  assert.throws(() => h.readActivity(), /unsupported shape/);
  assert.throws(() => h.logActivity('quiz_answer', {}), /unsupported shape/);
  assert.equal(fs.readFileSync(h.file, 'utf8'), original);
});

test('days active recognizes the activity types the app actually writes', t => {
  const h = journalHarness(t);
  const types = ['quiz_answer', 'problem_solved', 'code_review', 'task_update', 'behavioral_answer_reviewed', 'trainer_question_answered'];
  const journal = Object.fromEntries(types.map((type, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, { events: [{ type }] }]));
  journal['2026-09-07'] = { events: [{ type: 'feedback_reviewed' }] };
  journal['2026-09-08'] = { events: [{ type: 'code_solved' }] };
  assert.equal(h.countActiveDays(journal, []), types.length);
  assert.equal(h.countActiveDays(journal, [{ date: '2026-09-09', tasks: [{ completed: true }] }, { date: '2026-09-01', tasks: [{ completed: true }] }]), types.length + 1);
});
