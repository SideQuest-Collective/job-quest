const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const app = html.slice(html.indexOf('function App()'), html.indexOf('/* ===== INTERVIEWS'));
const mountedPages = [...new Set([...app.matchAll(/page === '([^']+)' && </g)].map(m => m[1]))].sort();

function routing(hash = '') {
  const block = html.match(/\/\* ===== PAGE HASH ROUTING ===== \*\/([\s\S]*?)\nfunction App\(/);
  assert.ok(block, 'dashboard must define page hash routing');
  const listeners = new Map(), replacements = [], effects = [];
  let current, initialized = false, cursor = 0;
  const window = {
    location: { hash },
    history: {
      state: { retained: true },
      replaceState(state, title, url) {
        assert.deepEqual(state, this.state);
        replacements.push(url);
        window.location.hash = url;
      },
      pushState() { assert.fail('page changes must not add history entries'); },
    },
    addEventListener: (type, handler) => { assert.equal(type, 'hashchange'); listeners.set(type, handler); },
    removeEventListener: (type, handler) => { assert.equal(listeners.get(type), handler); listeners.delete(type); },
  };
  const hook = vm.runInNewContext(`${block[1]}\nusePageRouting`, {
    window,
    useState(initial) {
      if (!initialized) { current = typeof initial === 'function' ? initial() : initial; initialized = true; }
      return [current, next => { current = typeof next === 'function' ? next(current) : next; }];
    },
    useEffect(fn, deps) {
      const i = cursor++, previous = effects[i];
      if (!previous || deps.some((v, j) => !Object.is(v, previous.deps[j]))) {
        effects[i] = { fn, deps, pending: true, cleanup: previous?.cleanup };
      }
    },
  });
  const render = () => {
    cursor = 0;
    const result = hook();
    for (const effect of effects) if (effect.pending) {
      effect.cleanup?.();
      effect.cleanup = effect.fn();
      effect.pending = false;
    }
    return result;
  };
  return {
    render, window, replacements, listeners,
    changeHash(next) { window.location.hash = next; listeners.get('hashchange')?.(); return render()[0]; },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

test('hash routing is wired into App and accepts exactly the mounted page IDs', () => {
  assert.match(app, /const \[page, setPage\] = usePageRouting\(\)/);
  assert.equal(mountedPages.length, 12);
  const block = html.match(/\/\* ===== PAGE HASH ROUTING ===== \*\/([\s\S]*?)\nfunction App\(/);
  assert.ok(block, 'dashboard must define page hash routing');
  const pageIds = vm.runInNewContext(`${block[1]}\nArray.from(PAGE_IDS)`);
  assert.deepEqual(Array.from(pageIds).sort(), mountedPages);
  for (const page of mountedPages) assert.equal(routing(`#${page}`).render()[0], page);
  for (const invalid of ['', '#code', '#tracker', '#divider1', '#__proto__', '#toString', '#INTEL', '#intel/extra']) {
    assert.equal(routing(invalid).render()[0], 'dashboard', invalid);
  }
});

test('bare dashboard URLs stay bare until navigation leaves the default page', () => {
  const h = routing();
  const [page, setPage] = h.render();
  assert.equal(page, 'dashboard');
  assert.equal(h.window.location.hash, '');
  assert.deepEqual(h.replacements, []);
  setPage('dashboard');
  h.render();
  assert.deepEqual(h.replacements, []);
  setPage('tasks');
  assert.equal(h.render()[0], 'tasks');
  assert.equal(h.window.location.hash, '#tasks');
  setPage('dashboard');
  assert.equal(h.render()[0], 'dashboard');
  assert.equal(h.window.location.hash, '#dashboard');
  assert.deepEqual(h.replacements, ['#tasks', '#dashboard']);
});

test('initial deep links select Intel, Daily Tasks, Workbooks, Code Lab and Trainer without being overwritten', () => {
  for (const page of ['intel', 'tasks', 'workbooks', 'codelab', 'trainer']) {
    const h = routing(`#${page}`);
    assert.equal(h.render()[0], page);
    assert.equal(h.window.location.hash, `#${page}`);
    assert.equal(h.replacements.length, 0);
  }
});

test('hashchange selects only known pages and removes its listener on unmount', () => {
  const h = routing('#intel');
  h.render();
  assert.equal(h.changeHash('#workbooks'), 'workbooks');
  for (const invalid of ['#missing', '#divider2', '#constructor', '#code', '']) {
    assert.equal(h.changeHash(invalid), 'workbooks', invalid);
  }
  assert.equal(h.changeHash('#trainer'), 'trainer');
  h.unmount();
  assert.equal(h.listeners.size, 0);
});

test('in-app page changes replace the hash once without adding history entries', () => {
  const h = routing('#intel');
  const [, setPage] = h.render();
  setPage('codelab');
  assert.equal(h.render()[0], 'codelab');
  assert.equal(h.window.location.hash, '#codelab');
  assert.deepEqual(h.replacements, ['#codelab']);
  h.render();
  assert.deepEqual(h.replacements, ['#codelab']);
});

test('existing workbook mock-interview links retain the selected page hash when removing the sd query', () => {
  const effect = app.match(/\/\/ The workbook viewer links[^\n]*\n(  useEffect\([\s\S]*?\n  \}, \[\]\);)/);
  assert.ok(effect, 'preserve workbook mock-interview launch handling');
  for (const initialHash of ['', '#sysdesign', '#intel']) {
    const h = routing(initialHash);
    const [, setPage] = h.render();
    Object.assign(h.window.location, { pathname: '/', search: '?sd=caching' });
    h.window.history.replaceState = (state, title, url) => {
      h.replacements.push(url);
      h.window.location.hash = url.includes('#') ? `#${url.split('#')[1]}` : '';
    };
    vm.runInNewContext(effect[1], {
      window: h.window, URLSearchParams, useEffect: fn => fn(),
      openSystemDesignTopic: topic => { assert.equal(topic.id, 'caching'); setPage('sysdesign'); },
    });
    assert.equal(h.render()[0], 'sysdesign');
    assert.equal(h.window.location.hash, '#sysdesign');
    assert.ok(h.replacements.every(url => !url.includes('?sd=')));
  }
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
