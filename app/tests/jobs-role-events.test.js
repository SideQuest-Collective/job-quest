// app/tests/jobs-role-events.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffRoleActions, diffTracker, createRoleEventBus } = require('../lib/jobs/role-events');

test('diffRoleActions returns only newly saved and applied keys', () => {
  const prev = { saved: ['A|x'], skipped: [], applied: [] };
  const next = { saved: ['A|x', 'B|y'], skipped: ['C|z'], applied: ['A|x'] };
  assert.deepEqual(diffRoleActions(prev, next), { saved: ['B|y'], applied: ['A|x'] });
});

test('diffRoleActions tolerates missing arrays', () => {
  assert.deepEqual(diffRoleActions({}, { saved: ['A|x'] }), { saved: ['A|x'], applied: [] });
});

test('diffTracker reports stage transitions into applied', () => {
  const prev = { 'A|x': { stage: 'saved' }, 'B|y': { stage: 'applied' } };
  const next = { 'A|x': { stage: 'applied' }, 'B|y': { stage: 'applied' }, 'C|z': { stage: 'applied' } };
  assert.deepEqual(diffTracker(prev, next), { applied: ['A|x', 'C|z'] });
});

test('bus delivers events to every listener', () => {
  const bus = createRoleEventBus();
  const got = [];
  bus.on('saved', (k) => got.push(['1', k]));
  bus.on('saved', (k) => got.push(['2', k]));
  bus.emit('saved', 'A|x');
  assert.deepEqual(got, [['1', 'A|x'], ['2', 'A|x']]);
});
