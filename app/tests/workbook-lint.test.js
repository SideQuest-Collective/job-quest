// app/tests/workbook-lint.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { lintWorkbook, errorsOnly } = require('../lib/workbook/lint');
const { CH1, CH2, GLOSS1, GLOSS2 } = require('./helpers/workbook-fixture');

const clean = () => ({ files: [{ name: '10-intro.md', text: CH1 }, { name: '20-algo.md', text: CH2 }], glossaryFiles: [{ name: 'glossary-10-intro.txt', text: GLOSS1 }, { name: 'glossary-20-algo.txt', text: GLOSS2 }] });
const rules = (findings) => findings.map((f) => f.rule);
const CH = '@@chapter id=c company=both topic="T" title="T"\n## In plain English\n\nx\n\n## Key takeaways\n\n- y\n';

test('the fixture kit is lint-clean', () => {
  assert.deepEqual(lintWorkbook(clean()), []);
});

for (const kind of ['chapter', 'q']) {
  for (const attr of ['id', 'company']) {
    test(`bad-id rejects unsafe ${kind} ${attr} values`, () => {
      for (const value of ['x"onclick="alert(1)', '-leading', 'Upper', 'under_score', 'x/y', 'x<y', '"two words"', '""']) {
        const attrs = { id: kind === 'chapter' ? 'c' : 'q', company: 'both', [attr]: value };
        const text = kind === 'chapter'
          ? CH.replace('id=c company=both', `id=${attrs.id} company=${attrs.company}`)
          : `${CH}\n@@q id=${attrs.id} company=${attrs.company} type=open diff=1 chapter=c\np\n@@rubric\n- r\n@@answer\na\n`;
        const findings = errorsOnly(lintWorkbook({ files: [{ name: 'unsafe.md', text }] }));
        const expectedRule = attr === 'id' && value === '""' ? 'missing-id' : 'bad-id';
        assert.equal(findings.length, 1, `${kind} ${attr}=${value}`);
        assert.equal(findings[0].rule, expectedRule, `${kind} ${attr}=${value}`);
        assert.equal(findings[0].file, 'unsafe.md');
        assert.equal(findings[0].line, kind === 'chapter' ? 1 : 10);
      }
    });
  }
}

test('bad-id accepts kit-style ids and company slugs, including both', () => {
  for (const id of ['m-c-1', 'start', 's-sources', 'ct-earn-6', '0']) {
    for (const company of ['acme-labs', 'both', '0']) {
      const text = `${CH.replace('id=c company=both', `id=${id} company=${company}`)}\n@@q id=${id}-q company=${company} type=open diff=1 chapter=${id}\np\n@@rubric\n- r\n@@answer\na\n`;
      assert.deepEqual(lintWorkbook({ files: [{ name: 'valid.md', text }] }), []);
    }
  }
});

test('duplicate ids are reported at the later occurrence, chapter refs must exist', () => {
  const f = lintWorkbook({ files: [{ name: 'a.md', text: CH }, { name: 'b.md', text: `${CH}\n@@q id=c type=open diff=1 chapter=nope\np\n@@rubric\n- r\n@@answer\na\n` }] });
  const dup = f.filter((x) => x.rule === 'dup-id');
  assert.equal(dup.length, 2);
  assert.ok(dup.every((x) => x.file === 'b.md'));
  assert.ok(rules(f).includes('chapter-ref'));
});

test('chapters need both required headings', () => {
  const f = lintWorkbook({ files: [{ name: 'a.md', text: '@@chapter id=c title="T"\n## Intro\n' }] });
  assert.deepEqual(rules(f), ['chapter-sections', 'chapter-sections']);
});

test('question rules: type, diff, answer, rubric', () => {
  const f = lintWorkbook({ files: [{ name: 'a.md', text: `${CH}\n@@q id=q1 type=essay diff=5 chapter=c\np\n\n@@q id=q2 type=open diff=1 chapter=c\np\n@@answer\na\n` }] });
  assert.deepEqual(rules(f).sort(), ['q-answer', 'q-diff', 'q-type', 'rubric']);
});

test('mcq needs 3+ choices with exactly one [x], and balanced lengths', () => {
  const few = lintWorkbook({ files: [{ name: 'a.md', text: `${CH}\n@@q id=q type=mcq diff=1 chapter=c\np\n@@choices\n- [x] a\n- [x] b\n@@answer\na\n` }] });
  assert.equal(few.filter((x) => x.rule === 'mcq-choices').length, 2);
  const unbalanced = lintWorkbook({ files: [{ name: 'a.md', text: `${CH}\n@@q id=q type=mcq diff=1 chapter=c\np\n@@choices\n- [ ] short\n- [ ] tiny\n- [x] this one is obviously the longest option by far\n@@answer\na\n` }] });
  assert.deepEqual(rules(unbalanced), ['mcq-balance']);
});

test('code questions need parseable @@tests and a reference defining entry', () => {
  const noTests = `${CH}\n@@q id=q type=code diff=1 chapter=c\np\n@@rubric\n- r\n@@answer\n\`\`\`python\ndef f(x):\n    return x\n\`\`\`\n`;
  assert.deepEqual(rules(lintWorkbook({ files: [{ name: 'a.md', text: noTests }] })), ['code-tests']);
  const relaxed = lintWorkbook({ files: [{ name: 'a.md', text: noTests }] }, { allowMissingTests: true });
  assert.deepEqual(relaxed.map((x) => [x.rule, x.severity]), [['code-tests', 'warning']]);
  assert.deepEqual(errorsOnly(relaxed), []);
  const badRef = noTests.replace('@@answer', '@@tests\n```json\n{"entry":"g","cases":[{"args":[1],"expect":1}]}\n```\n@@answer');
  assert.deepEqual(rules(lintWorkbook({ files: [{ name: 'a.md', text: badRef }] })), ['code-reference']);
  const badJson = noTests.replace('@@answer', '@@tests\n```json\n{oops\n```\n@@answer');
  assert.deepEqual(lintWorkbook({ files: [{ name: 'a.md', text: badJson }] }, { allowMissingTests: true }).map((x) => x.severity), ['error']);
});

test('</script is forbidden anywhere and glossary lines must parse', () => {
  const f = lintWorkbook({ files: [{ name: 'a.md', text: `${CH}</SCRIPT>\n` }], glossaryFiles: [{ name: 'glossary-01.txt', text: 'ok :: fine\nbroken line\n' }] });
  assert.deepEqual(rules(f), ['script-tag', 'glossary-line']);
  assert.deepEqual([f[0].file, f[0].line, f[1].file, f[1].line], ['a.md', 9, 'glossary-01.txt', 2]);
});
