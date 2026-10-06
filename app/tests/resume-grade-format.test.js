// app/tests/resume-grade-format.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkParseability, checkStructure, checkHistory } = require('../lib/resume/grade');
const { loadMaster, syntheticExtract } = require('./helpers/resume-fixtures');

const master = loadMaster();
const failed = (r) => r.checks.filter((c) => !c.pass).map((c) => c.id);
const swapText = (a, b) => (L) => L.map((l) => (l.text === a ? { ...l, text: b } : l.text === b ? { ...l, text: a } : l));

test('P: the synthetic rendered master passes all six checks', () => {
  const r = checkParseability(syntheticExtract(), { master });
  assert.equal(r.P, 30, JSON.stringify(r.checks));
  assert.deepEqual(r.checks.map((c) => c.id), ['one-page', 'min-words', 'heading-order', 'fonts-embedded', 'ascii-only', 'contact']);
});

test('P1 exactly one page', () => {
  const r = checkParseability(syntheticExtract(master, { pages: 2 }), { master });
  assert.deepEqual(failed(r), ['one-page']);
  assert.equal(r.P, 25);
});

test('P2 at least 300 words', () => {
  const ex = syntheticExtract(master, { lines: (L) => L.filter((l) => !l.text.startsWith('•')) });
  assert.deepEqual(failed(checkParseability(ex, { master })), ['min-words']);
});

test('P3 headings in order', () => {
  const ex = syntheticExtract(master, { lines: swapText('Experience', 'Skills') });
  assert.deepEqual(failed(checkParseability(ex, { master })), ['heading-order']);
});

test('P4 all fonts embedded', () => {
  assert.deepEqual(failed(checkParseability(syntheticExtract(master, { fontsEmbedded: false }), { master })), ['fonts-embedded']);
});

test('P5 only printable ASCII plus – ’ • “ ” |', () => {
  const ok = syntheticExtract(master, { lines: (L) => [...L, { text: '– ’ • “ ” |', x: 20, y: 0, page: 1 }] });
  assert.deepEqual(failed(checkParseability(ok, { master })), []);
  const bad = syntheticExtract(master, { lines: (L) => [...L, { text: 'Résumé ✓', x: 20, y: 0, page: 1 }] });
  const r = checkParseability(bad, { master });
  assert.deepEqual(failed(r), ['ascii-only']);
  assert.equal(r.checks.find((c) => c.id === 'ascii-only').detail, 'é✓');
});

test('P6 email, phone, LinkedIn, and the master location are in the body', () => {
  const moved = { ...master, contact: { ...master.contact, location: 'Shelbyville, IL' } };
  assert.equal(checkParseability(syntheticExtract(), { master: moved }).checks.find((c) => c.id === 'contact').detail, 'missing location');
  const noPhone = syntheticExtract(master, { lines: (L) => L.map((l, i) => (i === 2 ? { ...l, text: 'alex@example.com | linkedin.com/in/alex-example' } : l)) });
  assert.equal(checkParseability(noPhone, { master }).checks.find((c) => c.id === 'contact').detail, 'missing phone, location');
});

test('S: four standard headings and the target title (or its last two words)', () => {
  const kw = { title: 'Senior Software Engineer', required: [], preferred: [] };
  assert.equal(checkStructure(syntheticExtract(), { keywords: kw }).S, 15);
  const noSummary = syntheticExtract(master, { lines: (L) => L.map((l) => (l.text === 'Summary' ? { ...l, text: 'Profile' } : l)) });
  const r = checkStructure(noSummary, { keywords: kw });
  assert.equal(r.S, 12);
  assert.deepEqual(failed(r), ['heading-summary']);
  assert.equal(checkStructure(syntheticExtract(), { keywords: { title: 'Staff Data Engineer' } }).S, 12);
  assert.equal(checkStructure(syntheticExtract(), { keywords: { title: 'Principal Software Engineer' } }).S, 15);
});

test('H: the synthetic master passes all three history checks', () => {
  const r = checkHistory(syntheticExtract(), { master });
  assert.equal(r.H, 15, JSON.stringify(r.checks));
});

test('H1 one date format: a bare year fails; phone digits in the header never count', () => {
  const bare = syntheticExtract(master, { lines: (L) => L.map((l) => (l.text.startsWith('• Shipped a REST API') ? { ...l, text: '• Shipped a REST API in 2021 for 30+ merchants.' } : l)) });
  assert.deepEqual(failed(checkHistory(bare, { master })), ['date-format']);
  const m2 = { ...master, contact: { ...master.contact, phone: '(+1) 555-201-1999' } };
  assert.equal(checkHistory(syntheticExtract(m2), { master: m2 }).H, 15);
});

test('H2 roles must be newest first', () => {
  const reversed = JSON.parse(JSON.stringify(master));
  reversed.experience[0].roles.reverse();
  assert.deepEqual(failed(checkHistory(syntheticExtract(reversed), { master })), ['reverse-chronological']);
});

test('H3 every employer, title, and date range must equal master', () => {
  const m2 = JSON.parse(JSON.stringify(master));
  m2.experience[0].roles[0].title = 'Staff Software Engineer';
  assert.deepEqual(failed(checkHistory(syntheticExtract(), { master: m2 })), ['history-matches-master']);
  const m3 = JSON.parse(JSON.stringify(master));
  m3.experience[0].roles[1].start = '2019-09';
  assert.deepEqual(failed(checkHistory(syntheticExtract(), { master: m3 })), ['history-matches-master']);
  assert.equal(checkHistory(syntheticExtract(), { master: null }).H, 5);
});
