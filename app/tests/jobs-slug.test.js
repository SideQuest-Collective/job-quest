// app/tests/jobs-slug.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, uniqueSlug, roleSlug } = require('../lib/jobs/slug');

test('slugify lowercases, strips accents and symbols, collapses dashes', () => {
  assert.equal(slugify('Anthropic Staff+ Software Engineer, Platform'), 'anthropic-staff-software-engineer-platform');
  assert.equal(slugify('Café / Résumé — Ops'), 'cafe-resume-ops');
  assert.equal(slugify('  --A__B--  '), 'a-b');
});

test('slugify caps at 80 chars without a trailing dash', () => {
  const s = slugify('x'.repeat(50) + ' ' + 'y'.repeat(50));
  assert.ok(s.length <= 80);
  assert.ok(!s.endsWith('-'));
});

test('slugify falls back to "role" for empty or symbol-only input', () => {
  assert.equal(slugify('🚀🚀'), 'role');
  assert.equal(slugify(''), 'role');
});

test('uniqueSlug appends -2, -3 on collision', () => {
  const taken = new Set(['a', 'a-2']);
  assert.equal(uniqueSlug('a', (s) => taken.has(s)), 'a-3');
  assert.equal(uniqueSlug('b', (s) => taken.has(s)), 'b');
});

test('roleSlug combines company and role', () => {
  assert.equal(roleSlug('Acme Capital', 'Senior SWE - Fullstack', () => false), 'acme-capital-senior-swe-fullstack');
});
