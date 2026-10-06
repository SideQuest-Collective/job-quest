// app/tests/workbook-viewer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbook.html'), 'utf-8');

test('the viewer names no company and has exactly one data marker', () => {
  assert.doesNotMatch(html, /acme|hooli|onsite prep kit/i);
  assert.equal(html.split('<!--WB-DATA-->').length, 2);
  assert.doesNotMatch(html, /<!--CONTENT-->|text\/x-prep/);
});

test('the viewer script parses and runs as an async IIFE', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^\s*\(async function\(\)\{/);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test('progress is server-backed with an offline fallback and a legacy import', () => {
  for (const needle of [
    "'/api/workbooks/'", "'/content'", "'/progress'", "method:'PUT'", "'.pending'", 'setTimeout(flush,1000)',
    "getElementById('wb-data')", 'window.WB_OFFLINE', "'onsitePrep.v1'", 'Import progress from this browser',
    'Import a progress file', 'Practice as mock interview', '/?sd=', "addEventListener('online'",
  ]) assert.ok(html.includes(needle), needle);
});

test('company labels and filters come from the content', () => {
  for (const needle of ['const COMPANIES=[]', 'META.companyNames', "COMPANIES.map(function(c){return '<option value=\"'"]) assert.ok(html.includes(needle), needle);
});

test('no external resources are loaded', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
});

const vm = require('node:vm');
const { mergeProgress } = require('../lib/workbook/progress');
const clone = (value) => JSON.parse(JSON.stringify(value));
const at = '2026-10-05T12:00:00.000Z';

// Execute the complete IIFE with a minimal DOM and deterministic timer queue.
// Only the return value is instrumented; production code has no test hooks.
async function loadViewer({ progress = {}, offline = false, stored = {}, contentStatus = 200, customizeData = () => {}, putResponse } = {}) {
  const elements = new Map();
  const storage = new Map(Object.entries(stored));
  const events = {};
  const timers = new Map();
  const puts = [];
  const requests = [];
  const data = {
    meta: { id: 'sample', title: 'Sample workbook', source: 'imported', companyNames: { acme: 'Acme & Co' } },
    content: {
      chapters: [{ id: 'start', title: 'Welcome', company: 'acme', body: '' }],
      questions: [
        { id: 'q1', company: 'acme', topic: 'System design', body: 'Design a queue.', sdTopicId: 'queue/one' },
        { id: 'q2', company: 'acme', topic: 'Basics', type: 'mcq', body: 'Pick one.', choices: '- [x] Yes\n- [ ] No' },
      ],
      glossary: [],
    },
    progress,
  };
  customizeData(data);
  function element() {
    return { innerHTML: '', textContent: '', firstChild: {}, style: {},
      classList: { toggle() {}, remove() {} }, addEventListener() {},
      querySelectorAll() { return []; }, querySelector() { return null; } };
  }
  const document = {
    getElementById(id) {
      if (id === 'wb-data') return offline ? { textContent: JSON.stringify(data) } : null;
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    addEventListener() {}, createElement: element,
    body: { appendChild() {} }, documentElement: { setAttribute() {} },
  };
  let failPut = false;
  let timerId = 0;
  const context = vm.createContext({
    document,
    window: { WB_OFFLINE: offline, scrollTo() {}, addEventListener(name, handler) { events[name] = handler; } },
    location: { pathname: '/workbooks/sample', hash: '' },
    localStorage: { getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); }, clearInterval() {},
    async fetch(url, options) {
      requests.push(url);
      if (options?.method === 'PUT') {
        puts.push(JSON.parse(options.body));
        if (putResponse) return putResponse(puts.at(-1));
        return { ok: !failPut, status: failPut ? 503 : 200 };
      }
      if (url.endsWith('/content')) return { ok: contentStatus === 200, status: contentStatus, json: async () => clone(data) };
      return { ok: true, json: async () => clone(progress) };
    },
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(
    /route\(\);\s*\}\)\(\);\s*$/,
    'route(); return { S, save, flush, importLegacy, wireQ, QUESTIONS, qHTML, viewHome, viewGuide, viewRead, viewPractice, viewProgress, viewSearch }; })();',
  );
  const api = await vm.runInContext(script, context);
  return { api, elements, storage, events, timers, puts, requests,
    failPut(value) { failPut = value; },
    async saveNow() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      assert.equal(timer.ms, 1000);
      timers.delete(id);
      await timer.fn();
    } };
}

test('a viewer answer save preserves trainer attribution and grade history', async () => {
  const grade = { grade: 'got', at, source: 'trainer' };
  const progress = { grades: { q1: grade }, history: { q1: [grade] } };
  const viewer = await loadViewer({ progress });
  const textarea = { value: 'My answer' };
  viewer.api.wireQ(viewer.api.QUESTIONS[0], {
    querySelectorAll() { return []; }, querySelector() { return textarea; },
  }, () => {});
  textarea.oninput();
  textarea.oninput();
  await viewer.saveNow();
  assert.deepEqual(viewer.puts[0].grades.q1, grade);
  assert.equal(viewer.puts[0].answers.q1, 'My answer');
  const merged = mergeProgress(progress, viewer.puts[0]);
  assert.deepEqual(merged.grades.q1, grade);
  assert.deepEqual(merged.history.q1, [grade]);
});

test('an unchanged MCQ partial grade keeps its original value and source', async () => {
  const grade = { grade: 'partial', at, source: 'interview' };
  const viewer = await loadViewer({ progress: { grades: { q2: grade } } });
  await viewer.api.flush();
  assert.deepEqual(viewer.puts[0].grades.q2, grade);
});

test('a new viewer grade uses dashboard attribution and an ISO timestamp', async () => {
  const viewer = await loadViewer({ progress: { grades: { q1: { grade: 'got', at, source: 'trainer' } } } });
  const button = { dataset: { grade: 'partial' } };
  viewer.api.wireQ(viewer.api.QUESTIONS[0], {
    querySelectorAll(selector) { return selector === '[data-grade]' ? [button] : []; },
    querySelector() { return null; },
  }, () => {});
  button.onclick();
  await viewer.saveNow();
  const grade = viewer.puts[0].grades.q1;
  assert.equal(grade.grade, 'partial');
  assert.equal(grade.source, 'dashboard');
  assert.equal(grade.at, new Date(viewer.api.S.ans.q1.ts).toISOString());
});

test('failed saves persist locally and retry on online and reload', async () => {
  const viewer = await loadViewer();
  viewer.api.S.draft.q1 = 'Pending answer';
  viewer.api.S.ans.q1 = { s: 'got', ts: Date.parse(at) };
  viewer.failPut(true);
  await viewer.api.flush();
  const pending = viewer.storage.get('workbook.sample.pending');
  assert.equal(JSON.parse(pending).answers.q1, 'Pending answer');
  viewer.failPut(false);
  viewer.events.online();
  await new Promise(setImmediate);
  assert.equal(viewer.storage.has('workbook.sample.pending'), false);
  assert.equal(viewer.puts.length, 2);

  const reloaded = await loadViewer({ stored: { 'workbook.sample.pending': pending } });
  await new Promise(setImmediate);
  assert.equal(reloaded.api.S.draft.q1, 'Pending answer');
  assert.equal(reloaded.puts.length, 1);
  assert.equal(reloaded.storage.has('workbook.sample.pending'), false);
});

test('offline copies load and save locally without requests', async () => {
  const viewer = await loadViewer({ offline: true });
  viewer.api.S.draft.q1 = 'Offline answer';
  await viewer.api.flush();
  const pending = viewer.storage.get('workbook.sample.offline');
  assert.equal(JSON.parse(pending).answers.q1, 'Offline answer');
  assert.deepEqual(viewer.requests, []);
  const reloaded = await loadViewer({ offline: true, stored: { 'workbook.sample.offline': pending } });
  assert.equal(reloaded.api.S.draft.q1, 'Offline answer');
  assert.doesNotMatch(reloaded.api.qHTML(reloaded.api.QUESTIONS[0], 0, 1), /Practice as mock interview/);
});

test('legacy imports merge known answers, grades, and UI state', async () => {
  const viewer = await loadViewer();
  await viewer.api.importLegacy({
    ans: { q1: { s: 'miss', ts: Date.parse(at), rub: [0], revealed: true }, unknown: { s: 'got' } },
    read: { start: true }, flag: { q1: true }, draft: { q1: 'Old answer', unknown: 'Ignore' }, last: 'start',
  });
  const saved = viewer.puts[0];
  assert.deepEqual(saved.answers, { q1: 'Old answer' });
  assert.deepEqual(saved.grades, { q1: { grade: 'missed', at, source: 'dashboard' } });
  assert.deepEqual(saved.ui, { read: { start: true }, flag: { q1: true },
    picks: { q1: { rub: [0], revealed: true } }, legacyDone: true });
  assert.equal(saved.lastChapter, 'start');
});

test('the live page renders metadata labels, imports, and the encoded mock link', async () => {
  const viewer = await loadViewer({ stored: { 'onsitePrep.v1': '{"ans":{}}' } });
  assert.equal(viewer.elements.get('brand').firstChild.nodeValue, 'Sample workbook');
  assert.equal(viewer.elements.get('brandSub').textContent, 'Acme & Co');
  assert.match(viewer.elements.get('side').innerHTML, /Acme &amp; Co guide/);
  assert.match(viewer.elements.get('main').innerHTML, /Import progress from this browser/);
  assert.match(viewer.api.qHTML(viewer.api.QUESTIONS[0], 0, 1), /href="\/\?sd=queue%2Fone"/);
  viewer.api.viewProgress();
  assert.match(viewer.elements.get('main').innerHTML, /Import a progress file/);
});

test('a missing workbook renders the load error instead of throwing', async () => {
  const viewer = await loadViewer({ contentStatus: 404 });
  assert.equal(viewer.api, undefined);
  assert.match(viewer.elements.get('main').innerHTML, /Could not load this workbook/);
  assert.match(viewer.elements.get('main').innerHTML, /This workbook does not exist/);
});

for (const view of ['guide crumb', 'practice heading']) {
  test(`company display names render as text in the ${view}`, async () => {
    const viewer = await loadViewer({ customizeData(data) {
      data.meta.companyNames.acme = '<img src=x onerror=alert(1)>';
    } });
    if (view === 'guide crumb') viewer.api.viewRead('start');
    else viewer.api.viewPractice('acme');
    const markup = viewer.elements.get('main').innerHTML;
    assert.doesNotMatch(markup, /<img\b/i);
    assert.ok(markup.includes(view === 'guide crumb'
      ? '&lt;img src=x onerror=alert(1)&gt; guide</a>'
      : '<h1>Practice: &lt;img src=x onerror=alert(1)&gt;</h1>'));
  });
}

const hostileId = 'x"onclick="alert(1)';
const escapedId = 'x&quot;onclick=&quot;alert(1)';
for (const [view, render, expected, target = 'main'] of [
  ['continue reading', (api) => api.viewHome(), `href="#read/${escapedId}"`],
  ['guide card', (api) => api.viewGuide(hostileId), `data-go="#read/${escapedId}"`],
  ['guide crumb', (api) => api.viewRead(hostileId), `href="#guide/${escapedId}"`],
  ['chapter drill', (api) => api.viewRead(hostileId), `href="#practice/chapter/${escapedId}"`],
  ['previous chapter', (api) => api.viewRead('after'), `href="#read/${escapedId}"`],
  ['next chapter', (api) => api.viewRead('before'), `href="#read/${escapedId}"`],
  ['practice crumb', (api) => api.viewPractice(null, hostileId), `href="#read/${escapedId}"`],
  ['progress topic', (api) => api.viewProgress(), `href="#practice/${escapedId}"`],
  ['chapter search', (api) => api.viewSearch('needle'), `data-go="#read/${escapedId}"`],
  ['question search', (api) => api.viewSearch('needle'), `data-q="${escapedId}"`],
  ['side navigation', () => {}, `href="#guide/${escapedId}"`, 'side'],
]) {
  test(`content slugs cannot inject an onclick attribute in ${view}`, async () => {
    const viewer = await loadViewer({ progress: { lastChapter: hostileId }, customizeData(data) {
      data.content.chapters = ['before', hostileId, 'after'].map((id) => ({
        id, company: hostileId, title: 'needle', topic: 'Basics', body: 'needle',
      }));
      data.content.questions = [{ id: hostileId, company: hostileId, chapter: hostileId, topic: 'Basics', body: 'needle' }];
    } });
    render(viewer.api);
    const markup = viewer.elements.get(target).innerHTML;
    assert.ok(markup.includes(expected), markup);
    assert.doesNotMatch(markup, /"\s*onclick\s*=/i);
  });
}

for (const firstFails of [false, true]) {
  test(`flush serializes overlapping saves after ${firstFails ? 'failure' : 'success'}`, async () => {
    const pending = [];
    let serverAnswers = {};
    const viewer = await loadViewer({ putResponse(payload) {
      return new Promise((resolve) => pending.push((ok = true) => {
        if (ok) serverAnswers = payload.answers;
        resolve({ ok, status: ok ? 200 : 503 });
      }));
    } });
    viewer.api.S.draft.q1 = 'First answer';
    const first = viewer.api.flush();
    await new Promise(setImmediate);
    viewer.api.S.draft.q1 = 'Second answer';
    const second = viewer.api.flush();
    viewer.api.S.draft.q1 = 'Newest answer';
    const third = viewer.api.flush();
    await new Promise(setImmediate);
    assert.equal(viewer.puts.length, 1, 'later PUTs must wait for the in-flight PUT');
    pending.shift()(!firstFails);
    await first;
    await new Promise(setImmediate);
    assert.equal(viewer.puts.length, 2, 'only the next queued PUT may start');
    pending.shift()();
    await second;
    await new Promise(setImmediate);
    assert.equal(viewer.puts.length, 3);
    pending.shift()();
    await third;
    assert.equal(serverAnswers.q1, 'Newest answer');
    assert.equal(viewer.storage.has('workbook.sample.pending'), false);
  });
}

test('fix round 1: omitted company renders shared fundamentals', async () => {
  const viewer = await loadViewer({ customizeData(data) { delete data.content.chapters[0].company; } });
  viewer.api.viewRead('start');
  assert.match(viewer.elements.get('main').innerHTML, /Shared fundamentals/);
  assert.doesNotMatch(viewer.elements.get('main').innerHTML, /undefined guide/);
});
