const test = require('node:test');
const assert = require('node:assert/strict');

const { findRecordByDate, getLocalDateStamp, preferTodayOrLatest } = require('../lib/local-date');

test('getLocalDateStamp uses local calendar components', () => {
  const value = getLocalDateStamp(new Date(2026, 3, 23, 23, 30, 0));
  assert.equal(value, '2026-04-23');
});

test('findRecordByDate returns the matching dated record', () => {
  const records = [
    { date: '2026-04-24', value: 'newest' },
    { date: '2026-04-23', value: 'today' },
  ];

  assert.deepEqual(findRecordByDate(records, '2026-04-23'), { date: '2026-04-23', value: 'today' });
  assert.equal(findRecordByDate(records, '2026-04-22'), null);
});

test('preferTodayOrLatest prefers today and falls back to latest', () => {
  const records = [
    { date: '2026-04-24', value: 'latest' },
    { date: '2026-04-23', value: 'today' },
  ];

  assert.deepEqual(preferTodayOrLatest(records, '2026-04-23'), { date: '2026-04-23', value: 'today' });
  assert.deepEqual(preferTodayOrLatest(records, '2026-04-22'), { date: '2026-04-24', value: 'latest' });
  assert.equal(preferTodayOrLatest([], '2026-04-23'), null);
});
