// app/tests/workbook-orchestrator-chapters.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../lib/workbook/store');
const { createWorkbookHandler } = require('../lib/workbook/orchestrator');
const { parseContentDir } = require('../lib/workbook/parse');
const { lintWorkbook, errorsOnly } = require('../lib/workbook/lint');
const { runAgent: realRunAgent } = require('../lib/jobs/runner');
const { setup, setConfig, noLinks, agentCalls, contentHashes, maxConcurrency, job, useFakeRuntime } = require('./helpers/workbook-fakes');

const HAS_PY = !spawnSync('python3', ['--version']).error;
const handlerFor = (dataDir, extra = {}) => createWorkbookHandler({ dataDir, linkCheck: noLinks, ...extra });
const lintErrors = (dir) => errorsOnly(lintWorkbook(parseContentDir(path.join(dir, 'content'))));
const events = (dir) => fs.readFileSync(path.join(dir, '.fake', 'writer-events.log'), 'utf-8');
const crashAt = (point) => {
  let crashed = false;
  return (event) => {
    if (event === point && !crashed) { crashed = true; throw Object.assign(new Error('simulated crash'), { simulatedCrash: true }); }
  };
};
const SCREEN_FILES = ['01-acme-context.md', '02-arrays.md', '03-feed-design.md', '04-stories.md', '05-caching.md', 'glossary-01.txt', 'glossary-02.txt', 'glossary-03.txt', 'glossary-04.txt', 'glossary-05.txt'];

test('fix round 3: failed editors publish chapters with an unreviewed count retained on expansion', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta } = setup();
  const handler = handlerFor(dataDir, {
    verify: async q => ({ qid: q.id, pass: true, failures: [] }),
    runAgent: args => args.agent.startsWith('editor-')
      ? Promise.resolve({ ok: false, code: 1, stderr: 'Usage limit reached' }) : realRunAgent(args),
  });
  assert.equal((await handler(job('screen', meta.id))).status, 'ready');
  const chapters = Object.values(store.readJob(dataDir, meta.id).chapters);
  assert.equal(chapters.length, 5);
  assert.ok(chapters.every(c => c.status === 'published' && c.review.ok === false));
  assert.equal(store.readMeta(dataDir, meta.id).unreviewedChapters, chapters.length);
  await handlerFor(dataDir, { verify: async q => ({ qid: q.id, pass: true, failures: [] }) })(job('onsite', meta.id, 'expand'));
  assert.equal(store.readMeta(dataDir, meta.id).unreviewedChapters, 5);
});

test('a screen-tier job publishes every chapter', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup();
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.deepEqual([res.chaptersDone, res.chaptersFailed, res.chaptersTotal], [5, 0, 5]);
  const m = store.readMeta(dataDir, meta.id);
  assert.deepEqual([m.status, m.tier, m.researched], ['ready', 'screen', true]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'content')).sort(), SCREEN_FILES);
  const content = store.viewerContent(dataDir, meta.id);
  assert.deepEqual([content.chapters.length, content.questions.length], [5, 25]);
  assert.deepEqual(lintErrors(dir), []);
  assert.deepEqual(agentCalls(dir), { researcher: 1, planner: 1, writer: 5, editor: 5 });
  const state = store.readJob(dataDir, meta.id);
  assert.ok(Object.values(state.chapters).every((c) => c.status === 'published'));
  assert.deepEqual(Object.keys(store.readJsonFile(path.join(dir, 'review.json'), {}).chapters).sort(), ['acme-context', 'arrays', 'caching', 'feed-design', 'stories']);
  assert.deepEqual(store.readJsonFile(path.join(dir, 'glossary.json'), []), [{ t: 'widget', d: 'A small thing.' }]);
  assert.match(fs.readFileSync(path.join(dir, 'content', '02-arrays.md'), 'utf-8'), /Plain, clear words\./);
  assert.equal(fs.existsSync(path.join(dir, 'drafts', '02-arrays.md')), false);
  if (HAS_PY) assert.ok(Object.values(store.readJsonFile(path.join(dir, 'verify.json'), {}).chapters).flat().every((r) => r.pass));
});

test('chapter writers run at most 3 at a time', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ writerDelayMs: 300 });
  await handlerFor(dataDir)(job('run-1', meta.id));
  const max = maxConcurrency(dir);
  assert.ok(max <= 3, `max ${max}`);
  assert.ok(max >= 2, `writers never overlapped (max ${max})`);
});

test('a chapter that fails lint gets one retry with the lint errors', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ brokenFirst: ['arrays'] });
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.equal(agentCalls(dir).writer, 6);
  assert.match(events(dir), /^start arrays fix-lint$/m);
  assert.match(fs.readFileSync(path.join(dir, 'drafts', '.agent-writer-arrays.prompt.md'), 'utf-8'), /\[chapter-sections\]/);
  assert.equal(store.readJob(dataDir, meta.id).chapters.arrays.attempts, 2);
});

test('a chapter that fails lint twice fails; the workbook is partial and only clean chapters publish', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ brokenAlways: ['arrays'] });
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'partial');
  assert.equal(store.readMeta(dataDir, meta.id).status, 'partial');
  const rec = store.readJob(dataDir, meta.id).chapters.arrays;
  assert.deepEqual([rec.status, rec.attempts], ['failed', 2]);
  assert.match(rec.lint.join('\n'), /chapter-sections/);
  assert.equal(fs.existsSync(path.join(dir, 'content', '02-arrays.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'failed', '02-arrays.md')), true);
  assert.equal(store.viewerContent(dataDir, meta.id).chapters.length, 4);
  assert.deepEqual(lintErrors(dir), []);
  assert.equal(agentCalls(dir).editor, 4);
});

test('one verify-fix round repairs a wrong reference solution', { skip: !HAS_PY }, async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ wrongCode: { arrays: 'once' } });
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.equal(agentCalls(dir).writer, 6);
  assert.match(events(dir), /^start arrays fix-verify$/m);
  assert.equal(store.readJob(dataDir, meta.id).chapters.arrays.fixRounds, 1);
});

test('the verify-fix loop is bounded at one round', { skip: !HAS_PY }, async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ wrongCode: { arrays: 'always' } });
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'partial');
  const rec = store.readJob(dataDir, meta.id).chapters.arrays;
  assert.deepEqual([rec.status, rec.fixRounds], ['failed', 1]);
  assert.match(rec.error, /still fails its own tests/);
  assert.equal(agentCalls(dir).writer, 6);
  assert.equal((events(dir).match(/^start arrays fix-verify$/gm) || []).length, 1);
});

test('editor edits that break lint are reverted and published content stays lint-clean', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ editorBreaks: ['caching'], editorBreaksCode: HAS_PY ? ['stories'] : [] });
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  const caching = fs.readFileSync(path.join(dir, 'content', '05-caching.md'), 'utf-8');
  assert.match(caching, /## Key takeaways/);
  assert.match(caching, /Plain words\./);
  assert.doesNotMatch(caching, /Plain, clear words/);
  const review = store.readJsonFile(path.join(dir, 'review.json'), {}).chapters;
  assert.equal(review.caching.reverted, true);
  assert.match(review.caching.reason, /chapter-sections/);
  assert.equal(review.arrays.reverted, false);
  assert.equal(review.arrays.findings.verdict, 'edited');
  if (HAS_PY) {
    assert.equal(review.stories.reverted, true);
    assert.match(review.stories.reason, /broke a reference solution/);
    assert.match(fs.readFileSync(path.join(dir, 'content', '04-stories.md'), 'utf-8'), /return x \+ 1/);
  }
  assert.deepEqual(lintErrors(dir), []);
  assert.equal(fs.existsSync(path.join(dir, '.prereview', '05-caching.md')), false);
});

test('a crash at any point resumes without re-running finished agents', async (t) => {
  useFakeRuntime(t);
  const base = setup();
  await handlerFor(base.dataDir)(job('run-1', base.meta.id));
  const expected = contentHashes(base.dir);
  const points = [
    'step:done:research', 'step:done:links', 'step:done:plan', 'chapter:written:arrays', 'step:done:write',
    'step:done:verify', 'chapter:reviewed:feed-design', 'step:done:review', 'step:done:glossary', 'chapter:published:stories',
  ];
  for (const point of points) {
    const { dataDir, meta, dir } = setup();
    const onEvent = crashAt(point);
    await assert.rejects(handlerFor(dataDir, { onEvent })(job('run-1', meta.id)), /simulated crash/, point);
    const res = await handlerFor(dataDir, { onEvent })(job('run-1', meta.id));
    assert.equal(res.status, 'ready', point);
    assert.deepEqual(contentHashes(dir), expected, point);
    assert.deepEqual(agentCalls(dir), { researcher: 1, planner: 1, writer: 5, editor: 5 }, point);
  }
});

test('onsite expansion adds chapters without modifying existing chapter files', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup();
  await handlerFor(dataDir)(job('run-1', meta.id));
  const before = contentHashes(dir);
  const res = await handlerFor(dataDir)(job('run-2', meta.id, 'expand'));
  assert.equal(res.status, 'ready');
  const after = contentHashes(dir);
  for (const [name, hash] of Object.entries(before)) assert.equal(after[name], hash, name);
  assert.deepEqual(Object.keys(after).filter((n) => !(n in before)).sort(), [
    '06-onsite-loop.md', '07-concurrency.md', '08-storage-design.md', '09-leadership.md',
    'glossary-06.txt', 'glossary-07.txt', 'glossary-08.txt', 'glossary-09.txt',
  ]);
  assert.equal(store.readMeta(dataDir, meta.id).tier, 'onsite');
  assert.equal(store.viewerContent(dataDir, meta.id).questions.length, 50);
  assert.match(fs.readFileSync(path.join(dir, 'research.md'), 'utf-8'), /## Sources[\s\S]*## Onsite research/);
  assert.match(fs.readFileSync(path.join(dir, '.fake', 'planner-prompt-1.md'), 'utf-8'), /"id": "acme-context"/);
  assert.equal(store.readJsonFile(path.join(dir, 'outline.json'), null).chapters.length, 9);
  assert.deepEqual(agentCalls(dir), { researcher: 2, planner: 2, writer: 9, editor: 9 });
  assert.deepEqual(lintErrors(dir), []);
});

test('generating into an interview-only workbook keeps the asked chapter and numbers below 99', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup();
  const markup = '@@q id=iv-20261001-1 company=acme topic="Interviews" type=open diff=2 chapter=asked-in-interviews\nHow would you rate-limit an API?\n@@rubric\n- Names a token bucket.\n@@answer\nUse a token bucket per client.';
  store.appendChapterQuestions(dataDir, meta.id, { intro: 'From your coding round.', questions: [{ id: 'iv-20261001-1', markup }] });
  const asked = contentHashes(dir)['99-asked-in-interviews.md'];
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.equal(contentHashes(dir)['99-asked-in-interviews.md'], asked);
  assert.deepEqual(Object.values(store.readJob(dataDir, meta.id).chapters).map((c) => c.file), ['01-acme-context.md', '02-arrays.md', '03-feed-design.md', '04-stories.md', '05-caching.md']);
  assert.match(fs.readFileSync(path.join(dir, '.fake', 'planner-prompt-0.md'), 'utf-8'), /How would you rate-limit an API\?/);
  assert.equal(store.viewerContent(dataDir, meta.id).chapters.length, 6);
  assert.deepEqual(lintErrors(dir), []);
});

test('retry re-runs only the failed chapters', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ brokenAlways: ['arrays'] });
  assert.equal((await handlerFor(dataDir)(job('run-1', meta.id))).status, 'partial');
  const before = contentHashes(dir);
  setConfig(dir, { brokenAlways: [] });
  const res = await handlerFor(dataDir)(job('run-2', meta.id, 'retry'));
  assert.equal(res.status, 'ready');
  const after = contentHashes(dir);
  for (const [name, hash] of Object.entries(before)) assert.equal(after[name], hash, name);
  assert.ok(after['02-arrays.md']);
  assert.deepEqual(agentCalls(dir), { researcher: 1, planner: 1, writer: 7, editor: 5 });
  const state = store.readJob(dataDir, meta.id);
  assert.equal(state.chapters.arrays.status, 'published');
  assert.equal(state.steps.research.status, 'skipped');
  assert.equal(store.readMeta(dataDir, meta.id).status, 'ready');
});

test('a crash while a writer is running preserves both lint attempts on resume', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ brokenFirst: ['arrays'] });
  let release;
  const otherWriterSaved = new Promise((resolve) => { release = resolve; });
  let duringWrite;
  const interrupted = handlerFor(dataDir, {
    runAgent: async (args) => {
      if (args.agent !== 'writer-arrays') return realRunAgent(args);
      // Hold the writer in flight until another chapter saves the shared state.
      // A process crash here must not consume an attempt or select fix-lint.
      await otherWriterSaved;
      duringWrite = store.readJob(dataDir, meta.id).chapters.arrays;
      throw Object.assign(new Error('simulated crash mid-write'), { simulatedCrash: true });
    },
    onEvent: (event) => {
      if (event.startsWith('chapter:written:')) release();
    },
  });
  await assert.rejects(interrupted(job('run-1', meta.id)), /simulated crash mid-write/);
  assert.deepEqual([duringWrite.status, duringWrite.attempts, duringWrite.lint], ['pending', 0, []]);
  assert.equal(store.readJob(dataDir, meta.id).chapters.arrays.attempts, 0);
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.equal(store.readJob(dataDir, meta.id).chapters.arrays.attempts, 2);
  assert.match(events(dir), /^start arrays write$/m);
  assert.match(events(dir), /^start arrays fix-lint$/m);
  assert.deepEqual(agentCalls(dir), { researcher: 1, planner: 1, writer: 6, editor: 5 });
});

test('mapLimit stops scheduling on error and drains in-flight work before rejecting', async () => {
  const { mapLimit } = require('../lib/workbook/steps-chapters');
  const started = [];
  const failure = new Error('worker failed');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let drained = false;
  let settled = false;
  const run = mapLimit([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) throw failure;
    await held;
    drained = true;
  });
  const checked = assert.rejects(run, (err) => {
    settled = true;
    assert.equal(err, failure);
    assert.equal(drained, true);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false);
  release();
  await checked;
});

test('review concurrency follows writerConcurrency', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta } = setup();
  let active = 0;
  let max = 0;
  const res = await handlerFor(dataDir, {
    writerConcurrency: 1,
    runAgent: async (args) => {
      if (!args.agent.startsWith('editor-')) return realRunAgent(args);
      active++;
      max = Math.max(max, active);
      try { return await realRunAgent(args); } finally { active--; }
    },
  })(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.equal(max, 1);
});

test('a crash during fix-verify preserves the repair round on resume', { skip: !HAS_PY }, async (t) => {
  useFakeRuntime(t);
  const base = setup({ wrongCode: { arrays: 'once' } });
  await handlerFor(base.dataDir)(job('run-1', base.meta.id));
  const { dataDir, meta, dir } = setup({ wrongCode: { arrays: 'once' } });
  let duringFix;
  await assert.rejects(handlerFor(dataDir, {
    runAgent: async (args) => {
      if (args.agent === 'writer-arrays' && /^MODE: fix-verify$/m.test(args.prompt)) {
        await new Promise((resolve) => setImmediate(resolve));
        duringFix = store.readJob(dataDir, meta.id).chapters.arrays;
        throw Object.assign(new Error('simulated crash mid-fix'), { simulatedCrash: true });
      }
      return realRunAgent(args);
    },
  })(job('run-1', meta.id)), /simulated crash mid-fix/);
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.deepEqual([duringFix.status, duringFix.fixRounds], ['written', 0]);
  assert.equal(store.readJob(dataDir, meta.id).chapters.arrays.fixRounds, 1);
  assert.deepEqual(agentCalls(dir), agentCalls(base.dir));
  assert.deepEqual(contentHashes(dir), contentHashes(base.dir));
});

for (const corruption of ['directive', 'code']) {
  test(`publish rejects a reviewed draft with a later ${corruption} corruption`, { skip: corruption === 'code' && !HAS_PY }, async (t) => {
    useFakeRuntime(t);
    const { dataDir, meta, dir } = setup();
    const res = await handlerFor(dataDir, {
      onEvent: (event, state) => {
        if (event !== 'step:start:publish') return;
        assert.equal(state.chapters.arrays.status, 'reviewed');
        const file = path.join(dir, 'drafts', '02-arrays.md');
        const text = fs.readFileSync(file, 'utf-8');
        fs.writeFileSync(file, corruption === 'directive'
          ? text.replace('@@chapter id=arrays', '@@chapter id=changed')
          : text.replace(/return x \+ 1/g, 'return x + 5'));
      },
    })(job('run-1', meta.id));
    assert.equal(res.status, 'partial');
    const rec = store.readJob(dataDir, meta.id).chapters.arrays;
    assert.equal(rec.status, 'failed');
    assert.match(rec.error, corruption === 'directive' ? /directive|chapter/ : /reference solution/);
    for (const file of [rec.file, rec.glossaryFile]) {
      assert.equal(fs.existsSync(path.join(dir, 'content', file)), false);
      assert.equal(fs.existsSync(path.join(dir, 'failed', file)), true);
    }
  });
}

test('review saves acceptance before removing the verified backup', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup();
  const rmSync = fs.rmSync;
  const removal = t.mock.method(fs, 'rmSync', (file, ...args) => {
    if (file === path.join(dir, '.prereview', '01-acme-context.md')) {
      throw Object.assign(new Error('simulated crash during backup cleanup'), { simulatedCrash: true });
    }
    return rmSync(file, ...args);
  });
  await assert.rejects(handlerFor(dataDir, { writerConcurrency: 1 })(job('run-1', meta.id)), /simulated crash during backup cleanup/);
  removal.mock.restore();
  const saved = store.readJob(dataDir, meta.id).chapters['acme-context'];
  assert.equal(saved.status, 'reviewed');
  assert.ok(saved.review);
  assert.equal(fs.existsSync(path.join(dir, '.prereview', saved.file)), true);
  const res = await handlerFor(dataDir, { writerConcurrency: 1 })(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  assert.equal(agentCalls(dir).editor, 5);
});

test('editor findings are normalized and malformed JSON records a concern', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup();
  const findings = {
    'acme-context': '{bad JSON',
    arrays: JSON.stringify({ chapterId: 'wrong', verdict: 42, edits: 'wrong', concerns: {}, extra: true }),
    'feed-design': JSON.stringify({ verdict: 'edited', edits: ['clearer'], concerns: ['check wording'], extra: true }),
    stories: '{}',
    caching: 'null',
  };
  const res = await handlerFor(dataDir, {
    runAgent: async (args) => {
      const result = await realRunAgent(args);
      if (args.agent.startsWith('editor-')) {
        const id = args.agent.slice('editor-'.length);
        fs.writeFileSync(path.join(args.cwd, '.review', `${id}.json`), findings[id]);
      }
      return result;
    },
  })(job('run-1', meta.id));
  assert.equal(res.status, 'ready');
  const review = store.readJsonFile(path.join(dir, 'review.json'), {}).chapters;
  const state = store.readJob(dataDir, meta.id);
  for (const id of Object.keys(findings)) {
    assert.deepEqual(review[id].findings, {
      chapterId: id,
      verdict: id === 'feed-design' ? 'edited' : '',
      edits: id === 'feed-design' ? ['clearer'] : [],
      concerns: ['acme-context', 'caching'].includes(id) ? ['malformed review'] : id === 'feed-design' ? ['check wording'] : [],
    });
    assert.deepEqual(state.chapters[id].review.findings, review[id].findings);
  }
});

test('all generated chapters failing leaves an interview-only workbook failed and unchanged', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup({ brokenAlways: ['acme-context', 'arrays', 'feed-design', 'stories', 'caching'] });
  store.appendChapterQuestions(dataDir, meta.id, { questions: [{
    id: 'iv-20261001-1', markup: '@@q id=iv-20261001-1 company=acme topic="Interviews" type=open diff=2 chapter=asked-in-interviews\nAn interview question?\n@@rubric\n- One idea.\n@@answer\nAn answer.',
  }] });
  const before = contentHashes(dir);
  const res = await handlerFor(dataDir)(job('run-1', meta.id));
  assert.equal(res.status, 'failed');
  assert.deepEqual([res.chaptersDone, res.chaptersFailed, res.chaptersTotal], [0, 5, 5]);
  assert.equal(store.readMeta(dataDir, meta.id).status, 'failed');
  assert.deepEqual(contentHashes(dir), before);
  assert.equal(agentCalls(dir).editor || 0, 0);
});

test('fix round 1: writer and editor run inside drafts with relative targets', async (t) => {
  useFakeRuntime(t);
  const { dataDir, meta, dir } = setup();
  const seen = new Set();
  await handlerFor(dataDir, { runAgent: async (args) => {
    if (/^(writer|editor)-/.test(args.agent)) {
      seen.add(args.agent.split('-')[0]);
      assert.equal(args.cwd, path.join(dir, 'drafts'));
      assert.match(args.prompt, /^TARGET_FILE: [^/\n]+$/m);
      assert.match(args.prompt, /^GLOSSARY_FILE: [^/\n]+$/m);
      if (args.agent.startsWith('editor-')) assert.match(args.prompt, /^REVIEW_FILE: \.review\/[^/\n]+$/m);
    }
    return realRunAgent(args);
  } })(job('scratch', meta.id));
  assert.deepEqual([...seen].sort(), ['editor', 'writer']);
});
