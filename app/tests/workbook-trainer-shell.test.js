// app/tests/workbook-trainer-shell.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '..', '..', 'skill', 'bin');
const TRAINER = fs.readFileSync(path.join(BIN, 'run-interview-trainer.sh'), 'utf-8');
const REPLIES = fs.readFileSync(path.join(BIN, 'run-trainer-replies.sh'), 'utf-8');
const HAS_PY = !spawnSync('python3', ['--version']).error;

function heredocAfter(text, marker) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(marker));
  assert.ok(start >= 0, `marker not found: ${marker}`);
  const out = [];
  for (let i = start + 1; i < lines.length && lines[i] !== 'PY'; i++) out.push(lines[i]);
  return out.join('\n');
}

test('both scripts are valid bash', () => {
  for (const f of ['run-interview-trainer.sh', 'run-trainer-replies.sh']) {
    const r = spawnSync('bash', ['-n', path.join(BIN, f)], { encoding: 'utf-8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('the hourly trainer asks code for a due workbook question before calling the agent', () => {
  assert.match(TRAINER, /^deliver_message\(\) \{$/m);
  const pick = TRAINER.indexOf('trainer-pick.js" pick --data-dir "$JOB_QUEST_DATA_DIR"');
  const agent = TRAINER.indexOf('job_quest_run_prompt_file "$PROMPT_FILE"');
  assert.ok(pick > 0 && agent > pick, 'pick must come before the agent call');
  assert.equal((TRAINER.match(/osascript - "\$PHONE"/g) || []).length, 1);
  assert.match(TRAINER, /deliver_message "\$MESSAGE"/);
});

test('replies: MCQ graded by code first, grade recorded after each reply', () => {
  const mcq = REPLIES.indexOf('trainer-pick.js" mcq --data-dir "$JOB_QUEST_DATA_DIR"');
  const exchange = REPLIES.indexOf('# --- interviewer exchange');
  assert.ok(mcq > 0 && exchange > mcq);
  // Keywords must short-circuit before MCQ's non-letter attempt handling.
  for (const keyword of ['skip', 'next', 'done']) {
    const branch = REPLIES.indexOf(`# --- keyword: ${keyword}`);
    assert.ok(branch > 0 && branch < mcq, `${keyword} must precede MCQ grading`);
  }
  assert.match(REPLIES.slice(REPLIES.indexOf('# --- keyword: done'), mcq), /ANSWER=""/);
  assert.match(REPLIES.slice(REPLIES.indexOf('# --- keyword: done'), mcq), /if \[ -n "\$ANSWER" \]; then/);
  assert.ok(REPLIES.indexOf('trainer-pick.js" record --data-dir "$JOB_QUEST_DATA_DIR" --id "$TARGET_ID"') > REPLIES.indexOf('send_imessage "$REPLY_TEXT"'));
});

test('the evaluator prompt carries the rubric, answer key, and grade field for workbook questions', { skip: !HAS_PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shell-'));
  const qfile = path.join(dir, 'questions.json');
  const pfile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(qfile, JSON.stringify([{ id: 'tq_1', status: 'pending', company: 'Acme', role: 'Eng', category: 'system-design', question: 'Design a feed.', source: 'workbook', rubric: '- Mentions fan-out.', answerKey: 'Fan out on write.' }]));
  const builder = heredocAfter(REPLIES, '"$PROMPT_FILE" > "$META_FILE" <<\'PY\'');
  const r = spawnSync('python3', ['-', qfile, pfile], { input: builder, encoding: 'utf-8', env: { ...process.env, ANSWER: 'I would fan out.', FORCE_COMPLETE: '0' } });
  assert.equal(r.status, 0, r.stderr);
  const prompt = fs.readFileSync(pfile, 'utf-8');
  assert.match(prompt, /RUBRIC:\n- Mentions fan-out\./);
  assert.match(prompt, /ANSWER KEY:\nFan out on write\./);
  assert.match(prompt, /"grade":"got\|partial\|missed"\}/);
  fs.writeFileSync(qfile, JSON.stringify([{ id: 'tq_2', status: 'pending', company: 'Acme', category: 'technical', question: 'Normal question.' }]));
  spawnSync('python3', ['-', qfile, pfile], { input: builder, encoding: 'utf-8', env: { ...process.env, ANSWER: 'x', FORCE_COMPLETE: '0' } });
  assert.doesNotMatch(fs.readFileSync(pfile, 'utf-8'), /RUBRIC:|"grade"/);
});

test('the evaluation parser keeps a valid grade on the first evaluation', { skip: !HAS_PY }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shell-'));
  const qfile = path.join(dir, 'questions.json');
  fs.writeFileSync(qfile, JSON.stringify([{ id: 'tq_1', status: 'pending', company: 'Acme', source: 'workbook' }]));
  const composer = heredocAfter(REPLIES, 'python3 - "$QUESTIONS_FILE" > "$REPLY_FILE" <<\'PY\'');
  const raw = JSON.stringify({ score: 6, maxScore: 10, strengths: [], improvements: [], feedback: 'ok', followUp: 'Why?', complete: false, grade: 'partial' });
  const r = spawnSync('python3', ['-', qfile], { input: composer, encoding: 'utf-8', env: { ...process.env, RAW_EVAL: raw, TARGET_ID: 'tq_1', ANSWER: 'a', FORCE_COMPLETE_META: JSON.stringify({ forceComplete: false }) } });
  assert.equal(r.status, 0, r.stderr);
  const [q] = JSON.parse(fs.readFileSync(qfile, 'utf-8'));
  assert.equal(q.initialEvaluation.grade, 'partial');
  const bad = JSON.stringify({ score: 6, feedback: 'ok', followUp: null, complete: true, grade: 'great' });
  fs.writeFileSync(qfile, JSON.stringify([{ id: 'tq_1', status: 'pending', company: 'Acme' }]));
  spawnSync('python3', ['-', qfile], { input: composer, encoding: 'utf-8', env: { ...process.env, RAW_EVAL: bad, TARGET_ID: 'tq_1', ANSWER: 'a', FORCE_COMPLETE_META: JSON.stringify({ forceComplete: false }) } });
  assert.equal(JSON.parse(fs.readFileSync(qfile, 'utf-8'))[0].initialEvaluation.grade, undefined);
});

test('open and code workbook exchanges record only the first grade with source trainer', { skip: !HAS_PY }, (t) => {
  const store = require('../lib/workbook/store');
  const { writeKit } = require('./helpers/workbook-fixture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shell-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = store.createWorkbook(dir, { roleKeys: ['Acme|Staff Engineer'], status: 'ready' });
  writeKit(store.wbDir(dir, meta.id));
  const qfile = path.join(dir, 'trainer', 'questions.json');
  const composer = heredocAfter(REPLIES, 'python3 - "$QUESTIONS_FILE" > "$REPLY_FILE" <<\'PY\'');
  for (const [qtype, qid] of [['open', 'intro-2'], ['code', 'algo-1']]) {
    const id = `tq_${qtype}`;
    store.writeJsonAtomic(qfile, [{ id, status: 'pending', company: 'Acme', source: 'workbook', workbookId: meta.id, qtype, qid }]);
    let firstHistory;
    for (const [round, grade] of ['partial', 'got'].entries()) {
      const result = spawnSync('python3', ['-', qfile], {
        input: composer, encoding: 'utf-8',
        env: { ...process.env, TARGET_ID: id, ANSWER: round ? 'Improved answer' : 'First answer',
          FORCE_COMPLETE_META: JSON.stringify({ forceComplete: false }),
          RAW_EVAL: JSON.stringify({ score: round ? 10 : 6, feedback: 'ok', grade,
            followUp: round ? null : 'Why?', complete: Boolean(round) }) },
      });
      assert.equal(result.status, 0, result.stderr);
      const q = JSON.parse(fs.readFileSync(qfile, 'utf-8'))[0];
      assert.equal(q.initialEvaluation.grade, 'partial');
      assert.equal(q.evaluation.grade, grade);
      const record = spawnSync(process.execPath, [path.join(BIN, 'trainer-pick.js'), 'record',
        '--data-dir', dir, '--id', id], { encoding: 'utf-8' });
      assert.equal(record.status, 0, record.stderr);
      assert.deepEqual(JSON.parse(record.stdout), round
        ? { recorded: false, reason: 'already-recorded' }
        : { recorded: true, grade: 'partial' });
      const progress = store.readProgress(dir, meta.id);
      assert.equal(progress.grades[qid].grade, 'partial');
      assert.equal(progress.grades[qid].source, 'trainer');
      assert.equal(progress.grades[qid].at, new Date(progress.grades[qid].at).toISOString());
      if (round) assert.deepEqual(progress.history[qid], firstHistory);
      else firstHistory = progress.history[qid];
    }
  }
});
