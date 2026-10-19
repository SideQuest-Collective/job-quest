const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = html.split('/* PAGE LIFECYCLE START */')[1].split('/* PAGE LIFECYCLE END */')[0];

// Exercise the shipped lifecycle helpers, with controllable React hook scheduling.
function harness() {
  let active = true, cursor = 0, listeners = 0;
  const slots = [], effects = [], pending = [];
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  document.addEventListener = (name, fn) => { listeners++; add(name, fn); };
  document.removeEventListener = (name, fn) => { listeners--; remove(name, fn); };
  const element = (type, props, ...children) => ({ type, key: null, ref: null, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) }, valid: true });
  const React = {
    createContext: value => ({ Provider: 'Provider', defaultValue: value }),
    createElement: element, isValidElement: value => !!value?.valid,
    memo: (render, compare) => ({ render, compare }), useContext: () => active,
  };
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const useEffect = (fn, deps) => {
    const index = cursor++;
    if (!effects[index] || deps.some((dep, i) => !Object.is(dep, effects[index].deps[i]))) {
      pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; });
    }
  };
  const context = { React, useState, useEffect, document, window: {}, Object, JSON };
  vm.runInNewContext(`${source}\nthis.exported = {sameChild, RetainedContent, PageSurface, PageActiveContext, usePageVisible, setChangedJson};`, context);
  return {
    ...context.exported, element, document,
    setActive(value) { active = value; },
    renderVisibility() { cursor = 0; const value = context.exported.usePageVisible(); pending.splice(0).forEach(fn => fn()); return value; },
    get listeners() { return listeners; },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
  };
}

test('visible page memoization detects changed data, callbacks, identity, refs and added props', () => {
  const h = harness(), Component = () => {}, onSave = () => {}, data = {};
  const original = h.element(Component, { data, onSave });
  assert.equal(h.sameChild(original, h.element(Component, { data, onSave })), true);
  for (const changed of [
    h.element(Component, { data: {}, onSave }), h.element(Component, { data, onSave: () => {} }),
    h.element(Component, { data, onSave, active: true }), h.element(() => {}, { data, onSave }),
    { ...original, key: 'replacement' }, { ...original, ref: {} }, null,
  ]) assert.equal(h.sameChild(original, changed), false);
});

test('hidden page ignores parent updates but both visibility transitions always reach the retained subtree', () => {
  const h = harness(), Component = () => {};
  const old = { active: false, children: h.element(Component, { value: 1 }) };
  const next = { active: false, children: h.element(Component, { value: 2 }) };
  assert.equal(h.RetainedContent.compare(old, next), true);
  assert.equal(h.RetainedContent.compare(old, { ...next, active: true }), false);
  assert.equal(h.RetainedContent.compare({ ...old, active: true }, next), false);
  assert.equal(h.RetainedContent.compare({ ...old, active: true }, { ...next, active: true }), false);
  assert.equal(h.RetainedContent.render(next).props.children, next.children, 'latest children are forwarded when resumed');
});

test('nested page visibility cannot override its inactive parent and preserves the same children', () => {
  const h = harness(), children = h.element('editor', { draft: 'keep me' });
  h.setActive(false);
  const hidden = h.PageSurface({ as: 'div', active: true, children, className: 'nested' });
  assert.equal(hidden.type, 'div'); assert.equal(hidden.props.hidden, true);
  assert.equal(hidden.props.children.props.active, false);
  assert.equal(hidden.props.children.props.children, children);
  h.setActive(true);
  assert.equal(h.PageSurface({ active: true, children }).props.hidden, false);
});

test('unchanged JSON preserves state identity while changed server data replaces it', () => {
  const h = harness();
  let current = { records: [{ id: 'saved', completed: false }], total: 1 };
  const original = current;
  const setter = updater => { current = updater(current); };
  h.setChangedJson(setter, JSON.parse(JSON.stringify(current)));
  assert.equal(current, original);
  const changed = { records: [{ id: 'saved', completed: true }], total: 1 };
  h.setChangedJson(setter, changed); assert.equal(current, changed);
  h.setChangedJson(setter, null); assert.equal(current, null);
  h.setChangedJson(setter, null); assert.equal(current, null);
  h.setChangedJson(setter, []); assert.deepEqual(current, []);
});

test('poll visibility follows both active page and document visibility and removes its listener', () => {
  const h = harness();
  assert.equal(h.renderVisibility(), true); assert.equal(h.listeners, 1);
  h.setActive(false); assert.equal(h.renderVisibility(), false); assert.equal(h.listeners, 1);
  h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'));
  h.setActive(true); assert.equal(h.renderVisibility(), false, 'reopening a page in a hidden browser does not poll');
  h.document.visibilityState = 'visible'; h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.renderVisibility(), true, 'returning to visible browser resumes the active page');
  h.setActive(false); assert.equal(h.renderVisibility(), false);
  h.unmount(); assert.equal(h.listeners, 0);
});

test('page initially mounted in hidden browser remains paused until visibility changes', () => {
  const h = harness(); h.document.visibilityState = 'hidden';
  assert.equal(h.renderVisibility(), false);
  h.document.visibilityState = 'visible'; h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.renderVisibility(), true);
  h.unmount();
});

test('retained page content becomes visible immediately without disabling status animations', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/design-system.css'), 'utf8');
  const pageRule = css.match(/\.page-surface\s+\.anim-enter\s*\{([^}]+)\}/);
  assert.ok(pageRule, 'navigation animation override is scoped to retained page content');
  assert.match(pageRule[1], /animation\s*:\s*none\s*;/);
  assert.match(pageRule[1], /opacity\s*:\s*1\s*;/);
  assert.match(pageRule[1], /transform\s*:\s*none\s*;/);
  assert.ok(html.includes("animation:'pulse-dot 1.5s infinite'"), 'active feedback status animation remains available');
});
