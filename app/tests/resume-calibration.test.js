// app/tests/resume-calibration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAssignments } = require('../lib/resume/pyliteral');
const { importPySource } = require('../lib/resume/import-pysource');
const { extractPdf, scoreExtracted, loadTellWords } = require('../lib/resume/grade');
const { roundHalfEven, convertGradePyJd, gradePyScore, spearman } = require('./helpers/gradepy-port');
const { syntheticExtract, loadMaster, tmpDir } = require('./helpers/resume-fixtures');

// LOCAL ONLY: any corpus in JQ_RESUME_SRC with tools/{grade,content,build}.py and latex-src/<variant>/resume_cv.tex; the PDF pattern's first capture is its JD label.
const CAREER = process.env.JQ_RESUME_SRC;
const GRADE_PY = CAREER ? path.join(CAREER, 'tools', 'grade.py') : '';
function calibrationPdfPattern() { return new RegExp(process.env.JQ_RESUME_PDF_PATTERN || String.raw` - Resume \((.+)\)\.pdf$`); }
const PDF_PATTERN = calibrationPdfPattern();
const pdfs = CAREER && fs.existsSync(CAREER) ? fs.readdirSync(CAREER).filter((f) => PDF_PATTERN.test(f)).sort() : [];
const skip = CAREER && ['tools/grade.py', 'tools/content.py', 'tools/build.py', 'latex-src']
  .every((file) => fs.existsSync(path.join(CAREER, file))) && pdfs.length
  ? false : 'local calibration files not present';

test('calibration PDF matching accepts a configured filename pattern and label', (t) => {
  const corpus = tmpDir();
  t.after(() => fs.rmSync(corpus, { recursive: true, force: true }));
  for (const file of ['candidate-Acme.pdf', 'candidate-Hooli.pdf', 'notes.txt']) fs.writeFileSync(path.join(corpus, file), '');
  const originalPattern = process.env.JQ_RESUME_PDF_PATTERN;
  t.after(() => {
    if (originalPattern === undefined) delete process.env.JQ_RESUME_PDF_PATTERN;
    else process.env.JQ_RESUME_PDF_PATTERN = originalPattern;
  });
  process.env.JQ_RESUME_PDF_PATTERN = '^candidate-(.+)\\.pdf$';
  const pattern = calibrationPdfPattern();
  assert.deepEqual(fs.readdirSync(corpus).filter((file) => pattern.test(file)).sort(), ['candidate-Acme.pdf', 'candidate-Hooli.pdf']);
  assert.equal(pattern.exec('candidate-Hooli.pdf')[1], 'Hooli');
});

test('the grade.py port score does not depend on a fixed contact location', () => {
  const master = loadMaster();
  const jd = { title: 'Senior Software Engineer', kw: ['Python', 'Kafka', 'Fortran', 'scalab'] };
  for (const location of ['Springfield', '']) {
    master.contact.location = location;
    assert.equal(gradePyScore(syntheticExtract(master), jd, loadTellWords()), 70);
  }
});

function assertCorpusSize(pdfs, jds) {
  assert.ok(pdfs.length >= 2, 'calibration needs at least 2 PDFs');
  assert.ok(jds.length >= 3, 'calibration needs at least 3 distinct JD sets');
}

test('calibration accepts the minimum corpus and growth in PDFs or distinct JDs', () => {
  for (const [pdfCount, jdCount] of [[18, 12], [17, 13], [2, 3]]) {
    assert.doesNotThrow(() => assertCorpusSize(Array(pdfCount), Array(jdCount)));
  }
  assert.throws(() => assertCorpusSize(Array(1), Array(3)), assert.AssertionError);
  assert.throws(() => assertCorpusSize(Array(2), Array(2)), assert.AssertionError);
});

test('helpers agree with hand-computed values', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 2], [1, 1, 2]).toFixed(6), '1.000000');
  assert.ok(Math.abs(spearman([1, 1, 2], [1, 2, 3]) - Math.sqrt(3) / 2) < 1e-12);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), 0);
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  assert.equal(roundHalfEven(64.6), 65);
  assert.deepEqual(convertGradePyJd({ title: 'T', kw: ['Python', 'Flask|FastAPI'] }).required, [
    { term: 'Python*', alts: [] }, { term: 'Flask*', alts: ['FastAPI*'] },
  ]);
});

test('the grade.py port scores a known resume as computed by hand', () => {
  // kw 2/4 = 0.5 → 30; no fixed-location penalty → 25 for format; no tells → 15. Total 70.
  const jd = { title: 'Senior Software Engineer', kw: ['Python', 'Kafka', 'Fortran', 'scalab'] };
  assert.equal(gradePyScore(syntheticExtract(), jd, loadTellWords()), 70);
  assert.equal(gradePyScore(syntheticExtract(undefined, { pages: 2 }), jd, loadTellWords()), 65);
  assert.equal(gradePyScore(syntheticExtract(), jd, ['python']), 67);
});

test('calibration: our grader ranks the real tailored PDFs like grade.py (Spearman >= 0.7)', { skip, timeout: 600000 }, async (t) => {
  const env = parseAssignments(fs.readFileSync(GRADE_PY, 'utf-8'), { only: ['JD', 'TELLS_WORDS'] });
  const tellWords = loadTellWords();
  assert.deepEqual(env.TELLS_WORDS, tellWords, 'skill/references/resume/ai-tells.txt must equal grade.py TELLS_WORDS');
  const tools = path.join(CAREER, 'tools');
  const latexRoot = path.join(CAREER, 'latex-src');
  const tex = fs.readdirSync(latexRoot).sort().map((d) => path.join(latexRoot, d, 'resume_cv.tex')).find((p) => fs.existsSync(p));
  const edu = path.join(path.dirname(tex), 'cv-sections', 'education.tex');
  const master = importPySource({
    contentSrc: fs.readFileSync(path.join(tools, 'content.py'), 'utf-8'),
    buildSrc: fs.readFileSync(path.join(tools, 'build.py'), 'utf-8'),
    texSrc: fs.readFileSync(tex, 'utf-8'),
    educationSrc: fs.existsSync(edu) ? fs.readFileSync(edu, 'utf-8') : '',
  });
  const jds = [];
  const seen = new Set();
  for (const [name, jd] of Object.entries(env.JD)) {
    if (!jd || seen.has(jd)) continue;
    seen.add(jd);
    jds.push({ name, jd });
  }
  const ours = [];
  const theirs = [];
  const diagonal = [];
  assertCorpusSize(pdfs, jds);
  for (const file of pdfs) {
    const label = PDF_PATTERN.exec(file)[1];
    const ex = await extractPdf(path.join(CAREER, file));
    for (const { jd } of jds) {
      const a = scoreExtracted(ex, { keywords: convertGradePyJd(jd), master, tellWords }).total;
      const b = gradePyScore(ex, jd, tellWords);
      ours.push(a);
      theirs.push(b);
      if (env.JD[label] === jd) diagonal.push({ label, ours: a, gradePy: b });
    }
  }
  const rho = spearman(ours, theirs);
  t.diagnostic(`pdfs=${pdfs.length} jds=${jds.length} pairs=${ours.length} spearman=${rho.toFixed(3)}`);
  for (const d of diagonal) t.diagnostic(`own JD ${d.label}: ours ${d.ours}, grade.py formula ${d.gradePy}`);
  if (diagonal.length >= 3) {
    t.diagnostic(`own-JD spearman (informational) = ${spearman(diagonal.map((x) => x.ours), diagonal.map((x) => x.gradePy)).toFixed(3)}`);
  }
  assert.ok(rho >= 0.7, `Spearman rho ${rho.toFixed(3)} < 0.7`);
});
