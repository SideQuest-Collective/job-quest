// app/tests/resume-lexicon.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { termRegex, matchesAny, countMatches, isCaseInsensitiveEntry, loadGenericLexicon, buildLexicon } = require('../lib/resume/lexicon');
const { loadMaster } = require('./helpers/resume-fixtures');

test('termRegex matches on word boundaries and handles symbols', () => {
  assert.ok(termRegex('C++').test('Wrote C++ services'));
  assert.ok(!termRegex('Java').test('JavaScript only'));
  assert.ok(termRegex('Node.js').test('on Node.js.'));
  assert.ok(termRegex('CI/CD').test('a CI/CD pipeline'));
  assert.ok(termRegex('step functions').test('AWS Step  Functions'));
  assert.ok(!termRegex('Go').test('Good work'));
  assert.ok(termRegex('scalab*').test('scalability work'));
  assert.ok(!termRegex('scalab').test('scalability work'));
  assert.ok(!termRegex('Spring', { caseSensitive: true }).test('in spring we shipped'));
});

test('matchesAny and countMatches', () => {
  assert.equal(matchesAny('uses postgres daily', ['PostgreSQL', 'Postgres']), true);
  assert.equal(countMatches('PostgreSQL and Postgres and postgresql', ['PostgreSQL', 'Postgres']), 3);
});

test('case rule for generic entries', () => {
  assert.equal(isCaseInsensitiveEntry('Spring'), false);
  assert.equal(isCaseInsensitiveEntry('REST'), false);
  assert.equal(isCaseInsensitiveEntry('Step Functions'), false);
  assert.equal(isCaseInsensitiveEntry('PostgreSQL'), true);
  assert.equal(isCaseInsensitiveEntry('Node.js'), true);
  assert.equal(isCaseInsensitiveEntry('K8s'), true);
});

test('the shipped generic lexicon has 500+ unique entries of 2+ characters', () => {
  const list = loadGenericLexicon();
  assert.ok(list.length >= 500, `only ${list.length} entries`);
  assert.equal(new Set(list.map((t) => t.toLowerCase())).size, list.length, 'duplicate entries (case-insensitive)');
  assert.ok(list.every((t) => t.length >= 2 && !t.includes('*')));
});

test('buildLexicon finds generic and master terms, master terms case-insensitively', () => {
  const lex = buildLexicon(loadMaster());
  assert.ok(lex.terms.length >= 500);
  assert.deepEqual(lex.find('Shipped on Terraform and kubernetes with Lambda').sort(), ['Kubernetes', 'Lambda', 'Terraform']);
  assert.deepEqual(lex.find('expressed interest, express delivery, the rest of the spring'), []);
});

test('buildLexicon has uses the same case policy as detection', () => {
  const generic = ['Go', 'Swift', 'Spark', 'Glue', 'Lambda', 'React', 'PostgreSQL'];
  const lex = buildLexicon({}, { generic });
  for (const term of generic.slice(0, -1)) {
    assert.equal(lex.has(term, term), true, term);
    assert.equal(lex.has(term, term.toLowerCase()), false, term);
  }
  assert.equal(lex.has('PostgreSQL', 'postgresql'), true);
  assert.equal(lex.has('unknown', 'unknown'), false);
  const masterLex = buildLexicon({ skills: [{ items: ['Glue'] }] }, { generic });
  assert.deepEqual(masterLex.find('glue'), ['Glue']);
  assert.equal(masterLex.has('Glue', 'glue'), true);
});
