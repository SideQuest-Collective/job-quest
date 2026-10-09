const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadMaster, tmpDir, identityTailored } = require('./helpers/resume-fixtures');
const { validateMaster, writeMaster, readMaster, renderMarkdown, allMasterText } = require('../lib/resume/master');
const { buildDocument, renderTex, DEFAULT_TEMPLATE, latexEscape } = require('../lib/resume/render');

test('master save and exports retain extra sections, employer locations and both education dates', () => {
  const m = loadMaster();
  m.experience[0].location = 'New York, NY & Remote';
  m.education[0].start = '2011-09';
  m.education[0].end = '2015-05';
  m.additionalSections = [{ title: 'Leadership & Community', body: 'Mentored 12 engineers; led community workshops.\nVolunteer: 100% participant-led.' }];
  assert.deepEqual(validateMaster(m).errors, []);
  const dir = tmpDir();
  writeMaster(dir, m);
  const saved = readMaster(dir);
  assert.deepEqual(saved.additionalSections, m.additionalSections);
  assert.equal(saved.experience[0].location, m.experience[0].location);
  const doc = buildDocument(saved, identityTailored(saved));
  assert.deepEqual(doc.additionalSections, m.additionalSections);
  const tex = renderTex(fs.readFileSync(DEFAULT_TEMPLATE, 'utf8'), doc);
  assert.ok(tex.includes(latexEscape(m.experience[0].location)));
  assert.match(tex, /Sep 2011 -- May 2015/);
  assert.ok(tex.includes(latexEscape(m.additionalSections[0].title)));
  for (const line of m.additionalSections[0].body.split('\n')) assert.ok(tex.includes(latexEscape(line)));
  const md = renderMarkdown(saved);
  assert.ok(md.includes(m.additionalSections[0].body));
  assert.ok(md.includes(m.experience[0].location));
  assert.match(md, /Sep 2011 – May 2015/);
  assert.ok(allMasterText(saved).includes(m.additionalSections[0].body));
  assert.ok(validateMaster({ ...m, additionalSections: [{ title: 'A', body: 42 }] }).errors.includes('additionalSections[0].body: must be a string'));
  assert.ok(validateMaster({ ...m, additionalSections: 'bad' }).errors.includes('additionalSections: must be an array'));
});

test('legacy masters still validate and education without start does not invent a date', () => {
  const m = loadMaster();
  delete m.additionalSections;
  delete m.experience[0].location;
  m.education[0].start = '';
  m.education[0].end = '2015';
  assert.deepEqual(validateMaster(m).errors, []);
  const tex = renderTex(fs.readFileSync(DEFAULT_TEMPLATE, 'utf8'), buildDocument(m, identityTailored(m)));
  assert.match(tex, /\\hfill 2015 /);
  assert.doesNotMatch(tex, /\\hfill Present -- 2015/);
});
