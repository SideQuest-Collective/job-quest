// app/tests/interview-ui.test.js
// Structural checks; the visual check is Step 6 (manual, browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const count = (s) => html.split(s).length - 1;
const START = '/* ===== INTERVIEWS (/interview integration) ===== */';
const END = '/* ===== DASHBOARD ===== */';

test('components are defined once and mounted once each', () => {
  for (const name of ['InterviewsSection', 'UnlinkedSessions', 'InterviewNotInstalled', 'useInterviewStatus']) {
    assert.equal(count(`function ${name}(`), 1, name);
  }
  assert.equal(count('<InterviewsSection roleKey={selectedKey} />'), 1);
  assert.equal(count('<UnlinkedSessions />'), 1);
});

test('the component block sits right before the Dashboard section', () => {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  assert.ok(a > 0 && b > a);
});

test('the components call only the documented endpoints', () => {
  const block = html.slice(html.indexOf(START), html.indexOf(END));
  const urls = [...block.matchAll(/['`](\/api\/[^'`$?]*)/g)].map((m) => m[1]);
  const allowed = ['/api/interview/status', '/api/interview/sessions', '/api/interview/context', '/api/role-tracker', '/api/role-actions'];
  assert.ok(urls.length >= 6);
  for (const u of urls) assert.ok(allowed.some((a) => u.startsWith(a)), u);
});

test('the Interviews section is on the role page before Interview Tips', () => {
  const intel = html.indexOf('function Intel(');
  const mount = html.indexOf('<InterviewsSection roleKey={selectedKey} />');
  const tips = html.indexOf('{/* Interview Tips */}', intel);
  assert.ok(intel > 0 && mount > intel && mount < tips);
});

test('the Unlinked sessions list is mounted in the Workbooks page', () => {
  const mount = html.indexOf('<UnlinkedSessions />');
  const before = html.slice(0, mount);
  const owner = [...before.matchAll(/\nfunction (\w+)\(/g)].pop()[1];
  assert.ok(['Workbooks', 'PrepPlans'].includes(owner), owner);
});

test('the not-installed hint links to the interview-copilot repo', () => {
  assert.ok(html.includes("const INTERVIEW_REPO_URL = 'https://github.com/SideQuest-Collective/interview-copilot';"));
});

const vm = require('node:vm');
const block = html.slice(html.indexOf(START), html.indexOf(END));
const helpers = block.split('function InterviewNotInstalled(')[0];
const section = block.split('function InterviewsSection(')[1] || '';
const unlinked = block.split('function UnlinkedSessions(')[1] || '';
const flush = () => new Promise(resolve => setImmediate(resolve));

function helper(name, globals = {}) {
  return vm.runInNewContext(`${helpers}\n${name}`, { URL, ...globals });
}

test('both detail views use the single safe Markdown renderer', () => {
  assert.equal(count('function safeMarkdown('), 1);
  assert.match(section, /dangerouslySetInnerHTML=\{\{__html: renderedMarkdown\}\}/);
  assert.match(section, /React\.useMemo\(\(\) => markdown \? safeMarkdown\(markdown\) : '', \[markdown\]\)/);
  assert.doesNotMatch(section, /marked\.parse\(/);
  assert.match(section, /detail\.debriefMarkdown/);
  assert.match(section, /detail\.transcriptMarkdown/);
});

test('safe Markdown escapes raw HTML before parsing and removes unsafe rendered URLs', () => {
  const urls = ['javascript:alert(1)', 'data:text/html,bad', 'vbscript:bad', 'JaVaScRiPt:bad',
    'java\nscript:bad', 'https://example.com', 'http://example.com', 'mailto:hello@example.com', '/relative'];
  const nodes = urls.flatMap(value => ['href', 'src'].map(attr => ({
    attrs: { [attr]: value }, hasAttribute(key) { return key in this.attrs; },
    getAttribute(key) { return this.attrs[key]; }, removeAttribute(key) { delete this.attrs[key]; },
  })));
  let parsed;
  const template = { innerHTML: '', content: { querySelectorAll(selector) {
    if (selector === 'code') return [];
    assert.equal(selector, 'a[href], img[src]'); return nodes;
  } } };
  const safe = helper('safeMarkdown', {
    marked: { parse(md) { parsed = md; return '<p>rendered markdown</p>'; } },
    document: { createElement(tag) { assert.equal(tag, 'template'); return template; } },
  });
  assert.equal(safe('## Title\n**bold** & <img src=x onerror=alert(1)>'), '<p>rendered markdown</p>');
  assert.equal(parsed, '## Title\n**bold** &amp; &lt;img src=x onerror=alert(1)&gt;');
  nodes.forEach((node, i) => assert.equal(Object.keys(node.attrs).length, [5, 6, 7].includes(Math.floor(i / 2)) ? 1 : 0, urls[Math.floor(i / 2)]));
});

// Model marked's code escaping and the template's text-node serialization without
// adding browser dependencies. The safeMarkdown implementation itself runs in VM.
const escapeText = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const decodeText = text => text.replace(/&(amp|lt|gt);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>' }[name]));
function markdownHarness() {
  let markup, codes;
  const template = {
    set innerHTML(value) {
      markup = value;
      codes = [...value.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(match => ({
        textContent: decodeText(match[1]),
        set innerHTML(_) { assert.fail('code must be assigned through textContent'); },
      }));
    },
    get innerHTML() {
      let i = 0;
      return markup.replace(/<code>[\s\S]*?<\/code>/g, () => `<code>${escapeText(codes[i++].textContent)}</code>`);
    },
    content: { querySelectorAll: selector => selector === 'code' ? codes : [] },
  };
  const safe = helper('safeMarkdown', {
    document: { createElement: () => template },
    marked: { parse(md) {
      if (md.startsWith('```\n')) return `<pre><code>${escapeText(md.slice(4, -4))}\n</code></pre>\n`;
      if (md.startsWith('`')) return `<p><code>${escapeText(md.slice(1, -1))}</code></p>\n`;
      return `<p>${md}</p>\n`;
    } },
  });
  return { safe, codeText: () => codes.map(code => code.textContent) };
}

test('safe Markdown code spans display comparison and boolean operators as text', () => {
  const h = markdownHarness();
  assert.equal(h.safe('`a < b && c > d`'), '<p><code>a &lt; b &amp;&amp; c &gt; d</code></p>\n');
  assert.deepEqual(h.codeText(), ['a < b && c > d']);
});

test('safe Markdown fenced script tags stay inert text inside code', () => {
  const h = markdownHarness();
  const rendered = h.safe('```\n<script>alert(1)</script>\n```');
  assert.deepEqual(h.codeText(), ['<script>alert(1)</script>\n']);
  assert.equal(rendered, '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>\n');
  assert.doesNotMatch(rendered, /<script\b/i);
});

test('safe Markdown decodes only one level for literal entities typed inside code', () => {
  const h = markdownHarness();
  h.safe('`&lt; &gt; &amp;`');
  assert.deepEqual(h.codeText(), ['&lt; &gt; &amp;']);
});

test('safe Markdown leaves non-code escaping unchanged', () => {
  const h = markdownHarness();
  assert.equal(h.safe('a < b && c; literal &lt; <script>alert(1)</script>'),
    '<p>a &lt; b &amp;&amp; c; literal &amp;lt; &lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
  assert.deepEqual(h.codeText(), []);
});

test('empty uninstalled unlinked list returns only the install hint, preserving rows and errors', () => {
  // Execute the real hooks/filter/early-return conditions, representing JSX as text.
  const prefix = `function UnlinkedSessions(${unlinked.split('\n  return (')[0]}`
    .replace(/return (<[^\n]+>);/g, (_, jsx) => `return ${JSON.stringify(jsx)};`);
  function render({ installed = false, statusError = '', listError = '', roleError = '', sessions = [] } = {}) {
    let state = 0;
    const component = vm.runInNewContext(`${prefix}\nreturn 'section'; }\nUnlinkedSessions`, {
      useInterviewStatus: () => ({ installed, error: statusError }),
      useInterviewSessions: () => ({ sessions, error: listError }),
      useState: initial => [state++ === 4 ? roleError : initial, () => {}],
      useRef: initial => ({ current: initial }), useEffect: () => {},
    });
    return component();
  }
  const hint = render();
  assert.match(hint, /<InterviewNotInstalled status=\{status\} \/>/);
  assert.doesNotMatch(hint, /mc-section|Unlinked \/interview sessions|border|heading/);
  assert.equal(render({ installed: true }), null);
  for (const props of [{ listError: 'list failed' }, { roleError: 'roles failed' },
    { statusError: 'status failed' }, { sessions: [{ status: 'unlinked' }] }]) {
    assert.equal(render(props), 'section');
  }
});

test('InterviewsSection memoizes rendered markdown by string across poll renders and detail views', () => {
  const prefix = `function InterviewsSection(${section.split('\n  return (')[0]}`;
  const expression = section.match(/dangerouslySetInnerHTML=\{\{__html: ([^\n]+)\}\}/)[1];
  let detail = { debriefMarkdown: 'same', transcriptMarkdown: 'same' }, view = 'debrief';
  let cursor = 0, memo, calls = 0;
  const component = vm.runInNewContext(`${prefix}\nreturn ${expression}; }\nInterviewsSection`, {
    useInterviewStatus: () => ({ installed: true }),
    useInterviewSessions: () => ({ sessions: [{ folder: 'open', ingesting: true }] }),
    useState: initial => [[ 'open', detail, view ][cursor++] ?? initial, () => {}],
    useRef: initial => ({ current: initial }), useEffect: () => {},
    React: { useMemo(fn, deps) {
      if (!memo || deps.some((dep, i) => !Object.is(dep, memo.deps[i]))) memo = { deps, value: fn() };
      return memo.value;
    } },
    safeMarkdown: md => { calls++; return `rendered:${md}`; },
  });
  const render = () => { cursor = 0; return component({ roleKey: 'Acme|Engineer' }); };
  assert.equal(render(), 'rendered:same');
  assert.equal(calls, 1);
  assert.equal(render(), 'rendered:same'); // A session poll changes list state only.
  assert.equal(calls, 1, 'poll render must reuse the rendered markdown');
  detail = { ...detail }; // A new detail object with the same string must also reuse it.
  view = 'transcript';
  assert.equal(render(), 'rendered:same');
  assert.equal(calls, 1);
  detail = { ...detail, transcriptMarkdown: 'changed' };
  assert.equal(render(), 'rendered:changed');
  assert.equal(calls, 2);
});

test('request wrapper rejects API error objects as well as network failures', async () => {
  const request = helper('interviewRequest');
  await assert.rejects(request(Promise.resolve({ error: 'route failed' })), /route failed/);
  await assert.rejects(request(Promise.reject(new Error('network failed'))), /network failed/);
  assert.equal((await request(Promise.resolve({ installed: true }))).installed, true);
  // Every new API call must go through the wrapper, including both parallel requests.
  const calls = [...block.matchAll(/api\.(?:get|post)\(/g)];
  assert.ok(calls.length >= 6);
  for (const call of calls) assert.equal(block.slice(call.index - 17, call.index), 'interviewRequest(');
});

test('stored status labels, in-flight flags and failure diagnostics remain distinct', () => {
  const labels = helper('INTERVIEW_STATUS_LABELS');
  for (const status of ['unlinked', 'linking', 'ingesting', 'failed', 'ingested']) assert.ok(labels[status], status);
  const active = helper('interviewIsActive');
  for (const status of ['linking', 'ingesting']) assert.equal(active({ status }), true);
  assert.equal(active({ status: 'failed', ingesting: true }), true);
  assert.equal(active({ status: 'failed', ingesting: false }), false);
  for (const source of [section, unlinked]) {
    assert.match(source, /INTERVIEW_STATUS_LABELS\[s\.status\]/);
    assert.match(source, /s\.ingesting &&/);
    assert.match(source, /s\.status === 'failed' && s\.lastError &&/);
    assert.match(source, /debrief analysis failed: \{s\.analysisError\}/);
  }
});

function sessionsHarness(response) {
  const states = [], effects = [], timers = new Map();
  let seq = 0, requests = 0;
  const hook = helper('useInterviewSessions', {
    useState: initial => { const i = states.length; states.push(initial); return [initial, value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => ({ current: initial }), useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
    api: { get: async () => { requests++; return response(); } },
    setInterval: (fn, ms) => { assert.equal(ms, 3000); timers.set(++seq, fn); return seq; },
    clearInterval: id => timers.delete(id),
  });
  const model = hook('/api/interview/sessions');
  const cleanup = effects[0]();
  return { states, timers, model, cleanup, requests: () => requests };
}

test('sessions poll linking, stored ingesting and in-flight work, then stop at completion/unmount', async () => {
  for (const active of [{ status: 'linking' }, { status: 'ingesting' }, { status: 'failed', ingesting: true }]) {
    let rows = [active];
    const h = sessionsHarness(() => rows);
    await flush();
    assert.equal(h.timers.size, 1);
    rows = [{ status: 'ingested' }];
    await [...h.timers.values()][0]();
    assert.equal(h.timers.size, 0);
    rows = [active];
    await h.model.load();
    assert.equal(h.timers.size, 1);
    h.cleanup();
    assert.equal(h.timers.size, 0);
    const calls = h.requests();
    await h.model.load();
    assert.equal(h.requests(), calls);
  }
});

test('list errors stay visible, polling can recover, and late responses cannot update an unmounted list', async () => {
  let response = [{ status: 'linking' }];
  const h = sessionsHarness(() => response);
  await flush();
  response = { error: 'list failed' };
  await h.model.load();
  assert.equal(h.states[1], 'list failed');
  assert.equal(h.timers.size, 1);
  response = [];
  await h.model.load();
  assert.equal(h.states[1], '');
  let resolve;
  response = new Promise(r => { resolve = r; });
  const pending = h.model.load();
  h.cleanup();
  resolve([{ status: 'unlinked' }]);
  await pending;
  assert.equal(h.states[0].length, 0);
  for (const source of [section, unlinked]) assert.match(source, /\{listError && <div role="alert"/);
});

test('unlinked list keeps pending/failed links visible and preserves the tailored-resume mount', () => {
  assert.match(unlinked, /useInterviewSessions\('\/api\/interview\/sessions'\)/);
  assert.match(unlinked, /s\.status === 'unlinked'/);
  assert.match(unlinked, /s\.status === 'failed'/);
  assert.match(unlinked, /interviewIsActive\(s\)/);
  assert.match(html, /<TailoredResumeCard key=\{selectedKey\} roleKey=\{selectedKey\}/);
  const workbooks = html.slice(html.indexOf('function Workbooks('));
  assert.match(workbooks, /<\/button>\s*<\/div>\s*<UnlinkedSessions \/>/);
});

test('unlinked sessions collapse behind a remembered toggle and rows can be hidden and restored', () => {
  assert.match(unlinked, /aria-expanded=\{open\} onClick=\{\(\) => setOpen\(!open\)\}/);
  assert.match(unlinked, /localStorage\.getItem\('jq\.unlinkedOpen'\) === '1'/);
  assert.match(unlinked, /try \{ localStorage\.setItem\('jq\.unlinkedOpen'/);
  assert.match(unlinked, /\{open && <>/);
  assert.match(unlinked, /aria-label="Hide session"/);
  assert.match(unlinked, /\/\$\{hide \? 'dismiss' : 'restore'\}/);
  assert.match(unlinked, /dismissedSessions = allSessions\.filter\(s => s\.dismissed && s\.status === 'unlinked'\)/);
  assert.match(unlinked, /sessions = allSessions\.filter\(s => !s\.dismissed &&/);
  assert.match(unlinked, /\{showDismissed \? 'Hide' : 'Show'\} \{dismissedSessions\.length\} hidden session/);
});
