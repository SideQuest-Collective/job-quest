/*
 * Run here: node --test work/jobquest-redesign/tests/outreach-selection.test.cjs
 * Installed app: node --test tests/outreach-selection.test.js
 *
 * Dependencies: Node.js built-ins only. Like the existing opportunities UI tests,
 * this executes actual source in a VM. It loads all component control logic up
 * to the JSX return and exposes state/actions for a small hook harness. It does
 * not assert browser markup, CSS, or React DOM behavior. API data and mounted
 * document IDs are synthetic; unexpected endpoints and all writes are rejected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/opportunities.jsx'), 'utf8');
const markupStart = source.indexOf('  return <div className="jq-opps">');
assert.ok(markupStart > source.indexOf('window.Opportunities ='), 'Component control logic precedes the JSX return');
const controlSource = source.slice(0, markupStart) + `
  return { data, error, busy, view, catchUp, selected, visible, drafts, detailOpen,
    selectItem, changeView, returnToList, mutate, setDrafts, setCatchUp };
};`;

function conversation(id, company, status = 'ready_for_review') {
  return {
    id, company, title: 'Staff Engineer', kind: 'recruiter', status,
    checkedAt: '2026-10-19T12:00:00Z', draftReply: 'Saved ' + id,
    sourceLinks: ['https://example.com/messages/' + id], editable: true,
    revision: 'synthetic-revision', sourceAccount: 'Synthetic mailbox',
  };
}

function renderOutreach({ phone = false } = {}) {
  let slots = [], cursor = 0, pendingEffects = [], animationFrames = [];
  let state, needsRender = true, fixture;
  const requests = [], focused = [];
  const props = { setPage() {}, refreshKey: 0 };
  const React = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], update => {
        const next = typeof update === 'function' ? update(slots[slot]) : update;
        if (!Object.is(next, slots[slot])) { slots[slot] = next; needsRender = true; }
      }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect(effect, deps) {
      const slot = cursor++;
      const previous = slots[slot];
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[slot] = { deps, cleanup: previous?.cleanup };
        pendingEffects.push(() => {
          slots[slot].cleanup?.();
          slots[slot].cleanup = effect();
        });
      }
    },
  };
  const context = {
    React, Date, URL, Set, Map, Error, Object, Array, Number, String, Boolean, encodeURIComponent,
    requestAnimationFrame(callback) { animationFrames.push(callback); },
    setInterval() { throw Error('Unexpected access-check polling in Outreach'); },
    clearInterval() {},
    navigator: { clipboard: { async writeText() {} } },
    document: {
      getElementById(id) {
        // Model current mounting: one selected article and all visible list rows.
        // In particular, a deep link cannot focus its article before selection.
        const mounted = state?.selected && id === 'outreach-card-' + state.selected.id
          || state?.visible.some(item => id === 'outreach-row-' + item.id);
        return mounted ? { scrollIntoView() {}, focus() { focused.push(id); } } : null;
      },
    },
    async fetch(url, options) {
      assert.equal(options?.method || 'GET', 'GET', 'Tests must never write outreach data');
      assert.equal(url, '/api/opportunities', 'Only the synthetic outreach API is available');
      requests.push(url);
      return { ok: true, async json() { return structuredClone(fixture); } };
    },
    window: { matchMedia: () => ({ matches: phone }), dispatchEvent() {} },
  };
  vm.createContext(context);
  vm.runInContext(controlSource, context, { filename: 'opportunities-controls.js' });

  const harness = {
    props, requests, focused,
    get state() { return state; },
    setFixture(items) {
      fixture = { opportunities: items, briefState: 'ready', queueState: 'ready', accounts: [], sources: [] };
    },
    async settle() {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (needsRender) {
          needsRender = false;
          cursor = 0;
          state = context.window.Opportunities(props);
          const effects = pendingEffects;
          pendingEffects = [];
          effects.forEach(effect => effect());
        }
        await new Promise(setImmediate);
        if (!needsRender && animationFrames.length) {
          const frames = animationFrames;
          animationFrames = [];
          frames.forEach(frame => frame());
        }
        if (!needsRender && !pendingEffects.length && !animationFrames.length) return;
      }
      throw Error('Outreach did not settle after 20 renders');
    },
    async select(id) {
      const item = state.visible.find(candidate => candidate.id === id);
      assert.ok(item, 'Conversation is visible: ' + id);
      state.selectItem(item);
      await harness.settle();
    },
    async view(nextView) {
      state.changeView(nextView);
      await harness.settle();
    },
    async editDraft(id, draft) {
      state.setDrafts(previous => ({ ...previous, [id]: draft }));
      await harness.settle();
    },
    async older() {
      state.changeView('outreach');
      state.setCatchUp(!state.catchUp);
      await harness.settle();
    },
    async refresh(items) {
      if (items) harness.setFixture(items);
      props.refreshKey++;
      needsRender = true;
      await harness.settle();
    },
    async launch(id, request) {
      props.launchItem = { id, request };
      needsRender = true;
      await harness.settle();
    },
  };
  harness.setFixture([conversation('a', 'Atlas'), conversation('b', 'Beacon'), conversation('h', 'Held', 'hold_user')]);
  return harness;
}

function visibleIds(app) {
  return Array.from(app.state.visible, item => item.id);
}

test('defaults to the first visible conversation and selection stays within its view', async () => {
  const app = renderOutreach();
  await app.settle();
  assert.deepEqual(visibleIds(app), ['a', 'b']);
  assert.equal(app.state.selected.id, 'a');
  await app.select('b');
  assert.equal(app.state.selected.id, 'b');
  await app.view('held');
  assert.deepEqual(visibleIds(app), ['h']);
  assert.equal(app.state.selected.id, 'h');
  await app.view('outreach');
  assert.equal(app.state.selected.id, 'b', 'Returning to a view preserves its selection');
});

test('preserves dirty drafts across selection, filter changes and conflicting server refresh', async () => {
  const app = renderOutreach();
  await app.settle();
  await app.select('b');
  await app.editDraft('b', 'My unsaved reply');
  await app.select('a');
  await app.view('held');
  await app.view('outreach');
  await app.select('b');
  assert.equal(app.state.drafts.b, 'My unsaved reply');

  const changedA = { ...conversation('a', 'Atlas'), draftReply: 'New server reply A' };
  const changedB = { ...conversation('b', 'Beacon'), draftReply: 'Conflicting server reply B' };
  await app.refresh([changedA, changedB, conversation('h', 'Held', 'hold_user')]);
  assert.equal(app.state.selected.id, 'b');
  assert.equal(app.state.drafts.b, 'My unsaved reply');
  assert.equal(app.state.drafts.a, 'New server reply A', 'Unedited draft takes the latest server value');
  assert.equal(app.state.selected.draftReply, 'Conflicting server reply B', 'Server refresh really changed the underlying item');
  await app.state.mutate(app.state.selected, 'hold');
  await app.settle();
  assert.match(app.state.error, /Save the edited draft before changing/);
  assert.equal(app.requests.length, 2, 'Selection and dirty action guard never call a mutation API');
});

test('falls back when a selection disappears or no longer matches a filter, including empty views', async () => {
  const app = renderOutreach();
  await app.settle();
  await app.select('b');
  await app.refresh([conversation('a', 'Atlas'), conversation('h', 'Held', 'hold_user')]);
  assert.equal(app.state.selected.id, 'a');
  assert.deepEqual(visibleIds(app), ['a']);

  await app.refresh([conversation('a', 'Atlas'), conversation('b', 'Beacon', 'awaiting_recruiter'), conversation('h', 'Held', 'hold_user')]);
  await app.select('b');
  await app.older();
  assert.equal(app.state.selected.id, 'a');
  assert.deepEqual(visibleIds(app), ['a'], 'Awaiting conversations are excluded from older outreach');
  await app.view('held');
  assert.equal(app.state.selected.id, 'h');
  await app.refresh([conversation('a', 'Atlas')]);
  assert.equal(app.state.selected, null);
  assert.deepEqual(visibleIds(app), []);
  await app.view('outreach');
  assert.equal(app.state.selected.id, 'a');
});

test('paused dashboard deep link clears the older filter and focuses its selected detail only once', async () => {
  const app = renderOutreach({ phone: true });
  await app.settle();
  await app.select('b');
  assert.equal(app.focused.at(-1), 'outreach-card-b', 'Phone selection moves focus into the selected detail');
  await app.older();
  assert.equal(app.state.catchUp, true);
  await app.launch('h', 1);
  assert.equal(app.state.view, 'held');
  assert.equal(app.state.selected.id, 'h');
  assert.equal(app.state.catchUp, false);
  assert.equal(app.state.detailOpen, true);
  assert.equal(app.focused.at(-1), 'outreach-card-h', 'Deep link waits for its selected detail to be mounted');

  const focusedBeforeRefresh = app.focused.length;
  await app.refresh();
  assert.equal(app.focused.length, focusedBeforeRefresh, 'Refreshing data must not steal keyboard focus');
  app.state.returnToList();
  await app.settle();
  assert.equal(app.state.detailOpen, false);
  assert.equal(app.focused.at(-1), 'outreach-row-h');
  await app.refresh();
  assert.equal(app.state.detailOpen, false, 'An already-handled dashboard request must not reopen detail');
});
