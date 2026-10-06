// app/tests/resume-grade-keywords.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeForMatch, scoreKeywords } = require('../lib/resume/grade');
const { loadKeywords } = require('./helpers/resume-fixtures');

test('normalizeForMatch collapses whitespace and joins hyphenation', () => {
  assert.equal(normalizeForMatch('real-\n time  data\n\nflow'), 'real-time data flow');
});

test('K: all required and 2 of 3 preferred → 28', () => {
  const text = 'Python PostgreSQL AWS Kafka Kubernetes Docker Redis CI/CD on-call Redshift GitHub Actions Java';
  const r = scoreKeywords(normalizeForMatch(text), loadKeywords());
  assert.equal(r.K, 28);
  assert.deepEqual(r.keywords.requiredMiss, []);
  assert.deepEqual(r.keywords.preferredHit, ['GitHub Actions', 'Java']);
  assert.deepEqual(r.keywords.preferredMiss, ['Terraform']);
  assert.deepEqual(r.keywords.stuffed, []);
});

test('K: alts count as hits and matching is case-insensitive', () => {
  const text = 'python postgres amazon web services kafka k8s docker redis continuous integration on call redshift';
  const r = scoreKeywords(normalizeForMatch(text), { title: '', required: loadKeywords().required, preferred: [] });
  assert.equal(r.K, 30);
  assert.equal(r.keywords.requiredHit.length, 10);
});

test('K: empty preferred counts as 1.0', () => {
  const kw = { title: '', required: [{ term: 'Python', alts: [] }, { term: 'Rust', alts: [] }], preferred: [] };
  assert.equal(scoreKeywords('Python', kw).K, 18);
});

test('K: stuffing costs 2 per term used more than 3 times and K floors at 0', () => {
  const kw = { title: '', required: [{ term: 'AWS', alts: [] }], preferred: [] };
  assert.equal(scoreKeywords('AWS AWS AWS', kw).K, 30);
  const r = scoreKeywords('AWS AWS AWS AWS', kw);
  assert.equal(r.K, 28);
  assert.deepEqual(r.keywords.stuffed, ['AWS']);
  const many = { title: '', required: [{ term: 'Go', alts: [] }], preferred: Array.from({ length: 15 }, (_, i) => ({ term: `t${i}`, alts: [] })) };
  const stuffedText = Array.from({ length: 15 }, (_, i) => `t${i} t${i} t${i} t${i}`).join(' ');
  assert.equal(scoreKeywords(stuffedText, many).K, 0);
});
