const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const app = html.slice(html.indexOf('function App()'), html.indexOf('/* ===== INTERVIEWS'));
const mountedPages = [...new Set([...app.matchAll(/visited\.current\.has\('([^']+)'\)/g)].map(m => m[1]))].sort();

function routing(hash = '') {
  const block = html.match(/\/\* ===== PAGE HASH ROUTING ===== \*\/([\s\S]*?)\nfunction App\(/);
  assert.ok(block, 'dashboard must define page hash routing');
  const listeners = new Map(), pushes = [], replacements = [], slots = [], effects = [];
  let cursor = 0;
  const window = {
    location: { hash, pathname: '/', search: '' }, scrollY: 0,
    scrollTo(_x, y) { this.scrollY = y; },
    history: {
      state: null,
      pushState(state, _title, url) { this.state = state; pushes.push(url); window.location.hash = url.slice(url.indexOf('#')); },
      replaceState(state, _title, url) { this.state = state; replacements.push(url); window.location.hash = url.includes('#') ? `#${url.split('#')[1]}` : ''; },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { assert.equal(listeners.get(type), handler); listeners.delete(type); },
  };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[slot].value, next => { slots[slot].value = typeof next === 'function' ? next(slots[slot].value) : next; }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { current: initial };
      return slots[slot];
    },
    useCallback(fn, deps) {
      const slot = cursor++;
      if (!slots[slot] || !sameDeps(slots[slot].deps, deps)) slots[slot] = { value: fn, deps };
      return slots[slot].value;
    },
    useEffect(fn, deps) {
      const slot = cursor++;
      if (!effects[slot] || !sameDeps(effects[slot].deps, deps)) effects[slot] = { fn, deps, cleanup: effects[slot]?.cleanup, pending: true };
    },
  };
  const hook = vm.runInNewContext(`${block[1]}\nusePageRouting`, {
    window, requestAnimationFrame: fn => fn(), ...hooks,
  });
  const render = () => {
    cursor = 0;
    const result = hook();
    for (const effect of effects) if (effect?.pending) {
      effect.cleanup?.(); effect.cleanup = effect.fn(); effect.pending = false;
    }
    return result;
  };
  return {
    render, window, pushes, replacements, listeners,
    changeHash(next, type = 'hashchange') { window.location.hash = next; listeners.get(type)?.(); return render()[0]; },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
  };
}

test('routing accepts exactly the mounted page IDs, including new pages', () => {
  assert.match(app, /const \[page, setPage\] = usePageRouting\(\)/);
  const block = html.match(/\/\* ===== PAGE HASH ROUTING ===== \*\/([\s\S]*?)\nfunction App\(/);
  const pageIds = vm.runInNewContext(`${block[1]}\nArray.from(PAGE_IDS)`);
  assert.deepEqual(Array.from(pageIds).sort(), mountedPages);
  assert.ok(mountedPages.includes('practice') && mountedPages.includes('learn') && mountedPages.includes('opportunities'));
  for (const page of mountedPages) assert.equal(routing(`#${page}`).render()[0], page);
  for (const invalid of ['', '#code', '#tracker', '#divider1', '#__proto__', '#toString', '#INTEL', '#intel/extra']) {
    assert.equal(routing(invalid).render()[0], 'dashboard', invalid);
  }
});

test('bare dashboard URLs stay bare until navigation and use browser history', () => {
  const h = routing();
  const [page, setPage] = h.render();
  assert.equal(page, 'dashboard');
  assert.equal(h.window.location.hash, '');
  setPage('dashboard'); h.render();
  assert.deepEqual(h.pushes, []);
  setPage('tasks');
  assert.equal(h.render()[0], 'tasks');
  assert.equal(h.window.location.hash, '#tasks');
  setPage('dashboard');
  assert.equal(h.render()[0], 'dashboard');
  assert.deepEqual(h.pushes, ['#tasks', '#dashboard']);
  assert.deepEqual(h.replacements, []);
});

test('initial deep links select the requested page without adding history entries', () => {
  for (const page of ['intel', 'tasks', 'workbooks', 'codelab', 'trainer', 'practice', 'learn', 'opportunities']) {
    const h = routing(`#${page}`);
    assert.equal(h.render()[0], page);
    assert.equal(h.window.location.hash, `#${page}`);
    assert.deepEqual(h.pushes, []);
  }
});

test('hashchange and popstate restore known pages and listener cleanup', () => {
  const h = routing('#intel');
  h.render();
  assert.equal(h.changeHash('#workbooks'), 'workbooks');
  assert.equal(h.changeHash('#trainer', 'popstate'), 'trainer');
  assert.equal(h.changeHash('#missing'), 'dashboard');
  h.unmount();
  assert.equal(h.listeners.size, 0);
});

test('in-app navigation pushes once and restores saved scroll positions', () => {
  const h = routing('#intel');
  const [, setPage] = h.render();
  h.window.scrollY = 320;
  setPage('codelab'); h.render();
  assert.equal(h.window.scrollY, 0);
  h.window.scrollY = 190;
  setPage('intel'); h.render();
  assert.equal(h.window.scrollY, 320);
  assert.deepEqual(h.pushes, ['#codelab', '#intel']);
  setPage('intel'); h.render();
  assert.deepEqual(h.pushes, ['#codelab', '#intel']);
});

test('workbook mock-interview links remove sd query and select system design', () => {
  const effect = app.match(/\/\/ The workbook viewer links[^\n]*\n(  useEffect\([\s\S]*?\n  \}, \[\]\);)/);
  assert.ok(effect, 'preserve workbook mock-interview launch handling');
  const h = routing('#intel');
  const [, setPage] = h.render();
  Object.assign(h.window.location, { pathname: '/', search: '?sd=caching' });
  vm.runInNewContext(effect[1], {
    window: h.window, URLSearchParams, useEffect: fn => fn(),
    openSystemDesignTopic: topic => { assert.equal(topic.id, 'caching'); setPage('sysdesign'); },
  });
  assert.equal(h.render()[0], 'sysdesign');
  assert.equal(h.window.location.hash, '#sysdesign');
  assert.ok(h.replacements.every(url => !url.includes('?sd=')));
});

test('xbar onboarding and script reference document controls, states and logs', () => {
  const skill = fs.readFileSync(path.join(__dirname, '../../skill/SKILL.md'), 'utf8');
  const onboarding = skill.split('### Phase 7 (macOS only, optional): Offer the Menu Bar Plugin')[1].split('## Returning User Flow')[0];
  const reference = skill.split('### install-xbar.sh (macOS only)')[1].split('## /interview integration')[0];
  for (const section of [onboarding, reference]) {
    for (const control of ['Start Server', 'Stop Server', 'Restart Server', 'Refresh Intel Now']) assert.ok(section.includes(control), control);
    for (const state of ['running', 'unresponsive', 'stopped']) assert.ok(section.includes(state), state);
    assert.match(section, /View Dashboard Log/);
    assert.match(section, /daily-intel\.log/);
    assert.match(section, /dashboard\.log/);
  }
  assert.match(skill, /~\/\.job-quest\/bin\/start\.sh --background/);
});
