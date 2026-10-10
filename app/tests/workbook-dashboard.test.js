// app/tests/workbook-dashboard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

test('dashboard preserves native continuation and filters sourced highlights by actual role state', () => {
  const vm = require('node:vm');
  const home = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard-home.jsx'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'opportunities.jsx'), 'utf8');
  const window = {};
  vm.runInNewContext(source.split('window.Opportunities =')[0] + home.split('window.DashboardHome =')[0], {window, URL, Date});
  const role = {company:'Example', role:'Backend Engineer', url:'https://example.org/jobs/1'};
  const job = {id:'job',kind:'job',company:role.company,title:role.role,sourceLinks:[role.url],checkedAt:'2026-10-09'};
  const contact = {id:'contact',kind:'recruiter',company:'Other',title:'Engineer',checkedAt:'2026-10-09'};
  const due = {...contact,id:'due',status:'snoozed',nextReminderAt:'2000-01-01T00:00:00Z'};
  const paused = {...contact,id:'paused',status:'hold_preference'};
  assert.deepEqual(Array.from(window.dashboardHighlights([job,contact,due,paused],[role]).map(v=>v.id)),['contact','due','job']);
  assert.deepEqual(Array.from(window.dashboardHighlights([job,contact],[role],{applied:['Example|Backend Engineer']}).map(v=>v.id)),['contact']);
  assert.deepEqual(Array.from(window.dashboardHighlights([job],[role],{skipped:['Example|Backend Engineer']}).map(v=>v.id)),[]);
  assert.deepEqual(Array.from(window.dashboardHighlights([job],[role],{}, {'Example|Backend Engineer':{stage:'phone-screen'}}).map(v=>v.id)),[]);
  assert.match(home,/fetch\('\/api\/profile'\)/);
  assert.match(home,/continuation\.href/);
  assert.match(home,/reviewSource\?\.mode==='external'/);
});

test('the role page shows a workbook card and every JSON prep-plan trace is gone', () => {
  const h = html();
  for (const gone of [
    'interviewPlan', '/api/interview-plan', 'generatePlan', 'planLoadingKeys', 'quizScore', 'readinessScore',
    'savePrepState', 'isReady', 'prepTab', 'Prep Plans', "'prepplans'", "'prep-plan'", 'prep plan',
  ]) assert.ok(!h.includes(gone), gone);
  assert.match(h, /<WorkbookRoleSection roleKey=\{selectedKey\} \/>/);
  for (const needle of ['function WorkbookRoleSection(', 'Create workbook', "get('sd')", "source === 'workbook'", 'this workbook question and role context']) {
    assert.ok(h.includes(needle), needle);
  }
});

test('the Prep Plans tab is replaced by Workbooks', () => {
  const h = html();
  assert.doesNotMatch(h, /function PrepPlans|<PrepPlans|id: 'prepplans'/);
  assert.match(h, /\{ id: 'workbooks', icon: Icons\.clipboard, label: 'Workbooks' \}/);
  assert.match(h, /visited\.current\.has\('workbooks'\)[^\n]*hidden=\{page !== 'workbooks'\}[^\n]*<Workbooks setPage=\{setPage\} \/>/);
  assert.match(h, /page === 'workbooks' \|\| page === 'behavioral'/);
  for (const needle of [
    'function Workbooks(', 'function WorkbookCard(', "'/api/workbooks/backfill'", 'Build for all saved/applied (',
    '>Open workbook<', 'Expand to onsite', 'Retry failed', 'Download offline', '>Delete<', 'setInterval(poll, 3000)',
    'Auto-build for saved and applied roles', 'window.confirm(',
  ]) assert.ok(h.includes(needle), needle);
});

const vm = require('node:vm');
const workbookSource = () => html().split('/* ===== WORKBOOKS ===== */')[1]?.split('/* ===== HISTORY ===== */')[0] || '';

test('Intel no longer declares or receives the unused System Design callback', () => {
  assert.doesNotMatch(html().match(/function Intel\([^)]*\)/)[0], /openSystemDesignTopic/);
  assert.doesNotMatch(html().match(/<Intel\s[^>]*\/>/)[0], /openSystemDesignTopic/);
});

test('the Workbooks harness documents its positional hook order', () => {
  assert.match(workbooksHarness.toString(), /\/\/ Hook order: state = list, candidates, settings, building, saving, error; effects = initial load, active polling\./);
});

function roleHarness(fetch) {
  const source = workbookSource().split('function WorkbookRoleSection(')[1].split('function Workbooks(')[0];
  const prefix = `function WorkbookRoleSection(${source.slice(0, source.indexOf('\n  return ('))}`;
  // State slots: wb, creating, error; effect: initial load.
  const states = [], effects = [];
  const component = vm.runInNewContext(`${prefix}\nreturn { load, create }; }\nWorkbookRoleSection`, {
    useState: value => { const i = states.length; states.push(value); return [value, next => { states[i] = next; }]; },
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
    wbRequest: requestWith(fetch),
    api: {
      get: url => fetch(url, { method: 'GET' }).then(r => r.json()),
      post: (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
    },
  });
  const model = component({ roleKey: 'Acme|Staff Engineer' });
  effects[0]();
  return { model, states, source, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('a failed role workbook GET shows an alert and a later load clears it', async () => {
  for (const networkFailure of [false, true]) {
    let failing = true;
    const h = roleHarness(async (url, opts) => {
      assert.equal(url, '/api/workbooks');
      assert.equal(opts.method, 'GET');
      if (failing && networkFailure) throw new Error('workbook list unavailable');
      return { ok: !failing, status: failing ? 503 : 200,
        json: async () => failing ? { error: 'workbook list unavailable' } : [] };
    });
    await h.flush();
    assert.equal(h.states[2], 'workbook list unavailable');
    assert.equal(h.states[0], null);
    assert.match(h.source, /\{error && <div role="alert"[^>]*>\{error\}<\/div>\}/);
    failing = false;
    h.model.load();
    assert.equal(h.states[2], '');
    await h.flush();
    assert.equal(h.states[2], '');
  }
});

test('a failed role workbook POST keeps its alert visible and permits a successful retry', async () => {
  for (const networkFailure of [false, true]) {
    let failing = true, created = false;
    const h = roleHarness(async (url, opts) => {
      assert.equal(url, '/api/workbooks');
      if (opts.method === 'POST') {
        assert.deepEqual(JSON.parse(opts.body), { roleKey: 'Acme|Staff Engineer' });
        if (failing && networkFailure) throw new Error('workbook creation failed');
        created = !failing;
        return { ok: !failing, status: failing ? 500 : 201,
          json: async () => failing ? { error: 'workbook creation failed' } : {} };
      }
      return { ok: true, json: async () => created ? [{ id: 'acme', roleKeys: ['Acme|Staff Engineer'] }] : [] };
    });
    await h.flush();
    const pending = h.model.create();
    assert.equal(h.states[1], true);
    await assert.doesNotReject(pending);
    await h.flush();
    assert.equal(h.states[2], 'workbook creation failed');
    assert.equal(h.states[1], false);
    assert.match(h.source, /\{error && <div role="alert"[^>]*>\{error\}<\/div>\}/);
    failing = false;
    await h.model.create();
    await h.flush();
    assert.equal(h.states[2], '');
    assert.equal(h.states[1], false);
    assert.equal(h.states[0].id, 'acme');
  }
});

function requestWith(fetch) {
  const source = workbookSource().split('function WorkbookCard')[0];
  return vm.runInNewContext(`${source}\nwbRequest`, { fetch });
}

test('workbook requests reject HTTP errors with the server message and status', async () => {
  const request = requestWith(async () => ({ ok: false, status: 409, json: async () => ({ error: 'job running/queued' }) }));
  await assert.rejects(request('/api/workbooks/acme', 'DELETE'), e => e.message === 'job running/queued' && e.status === 409);
  const fallback = requestWith(async () => ({ ok: false, status: 503, json: async () => { throw new Error('not JSON'); } }));
  await assert.rejects(fallback('/api/workbooks', 'POST'), /503/);
  const success = requestWith(async (url, opts) => ({ ok: true, json: async () => ({ url, ...opts }) }));
  const result = await success('/api/settings', 'PUT', { workbooks: { autoBuild: false } });
  assert.equal(result.body, '{"workbooks":{"autoBuild":false}}');
});

// Exercise the card's effects/actions without JSX or new browser dependencies.
function cardHarness(wb, responses) {
  const source = workbookSource().split('function Workbooks(')[0];
  const prefix = source.slice(0, source.indexOf('\n  return ('));
  const effects = [], timers = new Map(), stateWrites = [];
  let requests = 0, changes = 0, nextTimer = 0;
  const get = async () => { requests++; return responses.shift(); };
  const card = vm.runInNewContext(`${prefix}\nreturn { active, canExpand, canRetry, progressLine, run, reviewWarning: typeof reviewWarning === "undefined" ? undefined : reviewWarning, jobError: typeof jobError === "undefined" ? undefined : jobError }; }\nWorkbookCard`, {
    useState: value => [value, next => stateWrites.push(next)],
    useRef: value => ({ current: value }),
    useEffect: effect => effects.push(effect),
    api: { get }, fetch: async () => ({ ok: true, json: get }),
    setInterval: (fn, ms) => { assert.equal(ms, 3000); timers.set(++nextTimer, fn); return nextTimer; },
    clearInterval: id => timers.delete(id),
  });
  const model = card({ wb, onChanged: () => changes++ });
  const cleanups = effects.map(effect => effect());
  return { model, timers, stateWrites, requests: () => requests, changes: () => changes,
    flush: () => new Promise(resolve => setImmediate(resolve)),
    cleanup: () => cleanups.forEach(fn => fn && fn()),
  };
}

test('fix round 3: card renders the unreviewed chapter warning as React text', () => {
  for (const [count, expected] of [[5, '5 chapters published without editor review'], [0, null], [undefined, null]]) {
    const h = cardHarness({ id: 'acme', status: 'ready', unreviewedChapters: count }, []);
    assert.equal(h.model.reviewWarning, expected);
    h.cleanup();
  }
  assert.match(workbookSource(), /\{reviewWarning && <div[^>]*>\{reviewWarning\}<\/div>\}/);
  assert.doesNotMatch(workbookSource(), /dangerouslySetInnerHTML/);
});

test('active cards poll at 3 seconds and stop on completion, including the first response', async () => {
  for (const terminal of ['done', 'failed']) {
    const h = cardHarness({ id: 'acme', status: 'queued' }, [{ queue: { status: terminal } }]);
    await h.flush();
    assert.equal(h.requests(), 1);
    assert.equal(h.changes(), 1);
    assert.equal(h.timers.size, 0);
    h.cleanup();
  }
  const h = cardHarness({ id: 'acme', status: 'generating' }, [{ queue: { status: 'running' } }, { queue: { status: 'done' } }]);
  await h.flush();
  assert.equal(h.timers.size, 1);
  await [...h.timers.values()][0]();
  await h.flush();
  assert.equal(h.requests(), 2);
  assert.equal(h.changes(), 1);
  assert.equal(h.timers.size, 0);
  h.cleanup();
});

test('idle and deferred cards do not poll; deferred cards cannot expand or retry', async () => {
  for (const status of ['ready', 'partial', 'failed', 'deferred']) {
    const h = cardHarness({ id: 'acme', status, failedChapters: 1 }, []);
    await h.flush();
    assert.equal(h.requests(), 0, status);
    assert.equal(h.timers.size, 0, status);
    if (status === 'deferred') {
      assert.match(h.model.progressLine, /limit|tomorrow/i);
      assert.equal(h.model.canRetry, false);
      assert.equal(h.model.canExpand, false);
    }
    h.cleanup();
  }
});

test('card action errors are surfaced and polling cleans up on unmount', async () => {
  const h = cardHarness({ id: 'acme', status: 'queued' }, [{ queue: { status: 'running' } }]);
  await h.flush();
  await h.model.run(async () => { throw new Error('job running/queued'); });
  assert.ok(h.stateWrites.includes('job running/queued'));
  h.cleanup();
  assert.equal(h.timers.size, 0);
});

test('workbook UI guards deletion and renders untrusted content as React text', () => {
  const source = workbookSource();
  assert.match(source, /deferred: 'var\(--amber\)'/);
  assert.match(source, /disabled=\{busy \|\| pending\}/);
  assert.match(source, /role="alert"[^>]*>\{error\}</);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.match(source, /\{wb\.company \|\| 'Workbook'\}/);
  assert.match(source, /\{wb\.role \|\| wb\.title\}/);
  assert.match(source, /\{wb\.status\}/);
});

function workbooksHarness(initialList, request, initialError = '') {
  const source = workbookSource().split('function Workbooks(')[1];
  const prefix = `function Workbooks(${source.slice(0, source.indexOf('\n  return ('))}`;
  // Hook order: state = list, candidates, settings, building, saving, error; effects = initial load, active polling.
  const states = [initialList, [], null, false, false, initialError];
  const effects = [], timers = new Map();
  let slot = 0;
  const component = vm.runInNewContext(`${prefix}\nreturn { load, anyActive }; }\nWorkbooks`, {
    useState: () => { const i = slot++; return [states[i], value => { states[i] = value; }]; },
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
    wbRequest: request,
    setInterval: (fn, ms) => { assert.equal(ms, 10000); timers.set(1, fn); return 1; },
    clearInterval: id => timers.delete(id),
  });
  const model = component({ setPage() {} });
  const cleanup = effects[1]();
  return { model, states, timers, cleanup: () => cleanup && cleanup(),
    flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('the Workbooks list refreshes only for queued or running work, not deferred work', () => {
  for (const [wb, expected] of [
    [{ status: 'deferred', job: { status: 'deferred' } }, false],
    [{ status: 'ready' }, false],
    [{ status: 'queued' }, true],
    [{ status: 'generating' }, true],
    [{ status: 'ready', job: { status: 'running' } }, true],
  ]) {
    const h = workbooksHarness([wb], async () => []);
    assert.equal(h.model.anyActive, expected, JSON.stringify(wb));
    assert.equal(h.timers.size, Number(expected));
    h.cleanup();
    assert.equal(h.timers.size, 0);
  }
});

test('each Workbooks load immediately clears the previous error', async () => {
  const h = workbooksHarness([], async () => [], 'previous failure');
  h.model.load();
  assert.equal(h.states[5], '');
  await h.flush();
  assert.equal(h.states[5], '');
});

test('a failed Workbooks GET exposes the empty state alongside its error', async () => {
  const h = workbooksHarness(null, async url => {
    if (url === '/api/workbooks') throw new Error('workbook list unavailable');
    return {};
  });
  h.model.load();
  await h.flush();
  assert.equal(h.states[5], 'workbook list unavailable');
  assert.ok(Array.isArray(h.states[0]));
  assert.equal(h.states[0].length, 0);
});

test('fix round 1: failed card exposes error text and the mode-appropriate action', () => {
  for (const mode of ['create', 'expand']) {
    const message = '<img src=x onerror=alert(1)> planner unavailable';
    const h = cardHarness({ id: 'acme', tier: 'screen', status: mode === 'expand' ? 'ready' : 'failed', lastError: message, job: { status: 'failed', mode, error: message } }, []);
    assert.equal(h.model.jobError, message);
    assert.equal(h.model.canExpand, mode === 'expand');
    assert.equal(h.model.canRetry, mode === 'create');
    assert.match(workbookSource(), /role="alert"[^>]*>\{jobError\}</);
    h.cleanup();
  }
  assert.equal(cardHarness({ status: 'ready', lastError: 'persisted' }, []).model.jobError, 'persisted');
});
