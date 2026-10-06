// app/tests/resume-guard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { numericTokens, checkTailored } = require('../lib/resume/guard');
const { buildLexicon } = require('../lib/resume/lexicon');
const { loadMaster, identityTailored } = require('./helpers/resume-fixtures');

const master = loadMaster();
const lexicon = buildLexicon(master);
const check = (t) => checkTailored(master, t, { lexicon });
const rules = (r) => r.violations.map((v) => v.rule);

for (const claim of [
  'Engineering Manager leading 12 engineers.', 'Head of Platform at Globex Corp.',
  'CTO at Globex Corp.', 'Vice President, Engineering.', 'Chief Technology Officer.',
  'Director, Engineering.', 'Staff-level Engineer', 'Principal.', 'Distinguished.',
  'Manager.', 'VP of Engineering.', 'Director of Platform.', 'Senior Staff.',
]) {
  test(`round 3 title claim: ${claim}`, () => {
    for (const field of ['summary', 'headline']) {
      const t = identityTailored(master);
      t[field] = claim;
      const result = check(t);
      assert.ok(result.violations.some(v => v.path === field && /titles not supported/.test(v.detail)), field);
      const supported = loadMaster();
      supported.summary += ` ${claim}`;
      assert.equal(checkTailored(supported, t).pass, true, JSON.stringify(checkTailored(supported, t).violations));
    }
  });
}

test('round 3 title verbs remain ordinary prose', () => {
  for (const summary of ['Lead design reviews', 'I lead design reviews', 'architect data platforms']) {
    const t = identityTailored(master);
    t.summary = summary;
    assert.equal(check(t).pass, true, summary);
  }
});

test('round 3 compact employer sentence boundaries preserve master abbreviations', () => {
  for (const employer of ['Globex Corp Inc', 'Globex Corp Inc.', 'Acme U.S.A. Inc']) {
    const m = loadMaster();
    m.experience[0].employer = employer;
    for (const punctuation of ['.', '!', '?']) {
      const t = identityTailored(m);
      t.summary = `Engineer at ${employer.replace(/\.$/, '')}${punctuation}Mentors 4 engineers.`;
      assert.equal(checkTailored(m, t).pass, true, t.summary);
    }
  }
  const t = identityTailored(master);
  t.summary = 'Engineer at Google.Mentors 4 engineers.';
  assert.deepEqual(check(t).violations, [{
    path: 'summary', rule: 7, detail: 'employers not supported by the master: Google',
  }]);
});

for (const [employer, nextSentence] of [
  ['Globex Corp', 'Led a migration'],
  ['Globex Corp.', 'Led a migration'],
  ['Globex Corp Inc', 'Mentors 4 engineers'],
]) {
  test(`employer sentence boundary: ${employer}`, () => {
    const m = loadMaster();
    m.experience[0].employer = employer;
    for (const punctuation of ['.', '!', '?']) {
      const t = identityTailored(m);
      t.summary = `Engineer at ${employer.replace(/\.$/, '')}${punctuation} ${nextSentence}.`;
      const result = checkTailored(m, t);
      assert.equal(result.pass, true, JSON.stringify(result.violations));
    }
  });
}

test('employer sentence boundary still rejects Google without absorbing Led', () => {
  const t = identityTailored(master);
  t.summary = 'Engineer at Google. Led a migration.';
  assert.deepEqual(check(t).violations, [{
    path: 'summary', rule: 7, detail: 'employers not supported by the master: Google',
  }]);
});

for (const verb of ['lead', 'head', 'architect']) {
  test(`title context: ${verb} verbs and title claims`, () => {
    const m = loadMaster();
    const title = verb[0].toUpperCase() + verb.slice(1);
    for (const summary of [`I ${verb} design reviews.`, `${title} design reviews.`]) {
      const t = identityTailored(m);
      t.summary = summary;
      assert.equal(checkTailored(m, t).pass, true, summary);
    }
    for (const field of ['headline', 'summary']) {
      for (const claim of [`${title} Engineer`, `Engineer ${title}`, `${title.toUpperCase()} ENGINEER`, `ENGINEER ${title.toUpperCase()}`]) {
        const t = identityTailored(m);
        t[field] = claim;
        assert.ok(checkTailored(m, t).violations.some(v => v.path === field && v.rule === 7 && v.detail.includes('titles')), claim);
      }
      const t = identityTailored(m);
      t[field] = `${verb} engineer`;
      assert.equal(checkTailored(m, t).pass, true, `${field}: ${t[field]}`);
    }
    const t = identityTailored(m);
    t.headline = `${title} design reviews`;
    assert.ok(checkTailored(m, t).violations.some(v => v.path === 'headline' && v.rule === 7));
  });
}

test('numericTokens normalizes suffixes, units and number words', () => {
  assert.deepEqual(
    numericTokens('50M+ events, $500M saved, 85%+ coverage, 8x faster, 15s to 3s, 45min, 1,000 rows, five teams, 3.50 points, 7 percent'),
    ['50m', '500m', '85%', '8x', '15', '3', '45', '1000', '5', '3.5', '7%'],
  );
  assert.deepEqual(numericTokens('P99 latency on EC2 and S3'), ['p99']);
});

test('identity tailoring passes', () => {
  const r = check(identityTailored(master));
  assert.equal(r.pass, true, JSON.stringify(r.violations));
});

for (const field of ['summary', 'headline']) {
  test(`rule 7: ${field} tenure cannot be licensed by an unrelated number`, () => {
    const m = loadMaster();
    m.summary = 'Engineer with 7+ years of experience.';
    m.experience[0].roles[0].bullets[0].text = 'Built 5 independently deployable services.';
    for (const claim of ['5+ years', '5 years', 'five years', '5 yrs', '5 year', '7 years']) {
      const t = identityTailored(m);
      t[field] = `Engineer with ${claim} of experience.`;
      const r = checkTailored(m, t);
      assert.deepEqual(r.violations.map((v) => `${v.path}:${v.rule}`), [`${field}:7`], claim);
      assert.match(r.violations[0].detail, /year/);
    }
    for (const claim of ['7+ years', 'seven+ yrs', '7+ year']) {
      const t = identityTailored(m);
      t[field] = `Engineer with ${claim} of experience.`;
      assert.equal(checkTailored(m, t).pass, true, claim);
    }
  });
}

test('rule 2: tenure must come from the source bullet, including its plus sign', () => {
  const m = loadMaster();
  m.summary = 'Engineer with 5 years of experience.';
  m.experience[0].roles[0].bullets[0].text = 'Built 5 independently deployable services.';
  const t = identityTailored(m);
  t.experience[0].roles[0].bullets[0].text = 'Built services for 5 years.';
  let r = checkTailored(m, t);
  assert.deepEqual(rules(r), [2]);
  assert.equal(r.violations[0].path, 'experience[0].roles[0].bullets[0].text');
  m.experience[0].roles[0].bullets[0].text = 'Built services for five yrs.';
  assert.equal(checkTailored(m, t).pass, true);
  t.experience[0].roles[0].bullets[0].text = 'Built services for 5+ years.';
  r = checkTailored(m, t);
  assert.deepEqual(rules(r), [2]);
  m.experience[0].roles[0].bullets[0].text = 'Built services for five+ years.';
  assert.equal(checkTailored(m, t).pass, true);
});

for (const field of ['summary', 'headline', 'bullet']) {
  for (const [claim, unsupported] of [
    ['5-year track record', '5 year'],
    ['5-plus years', '5+ year'],
    ['5 + years', '5+ year'],
    ['5-yr', '5 year'],
    ['7-plus years', null],
    ['7+ years', null],
    ['5-service', null],
  ]) {
    test(`tenure separators: ${field} ${claim}`, () => {
      for (const sourceClaim of ['7+ years', '7-plus years']) {
        const m = loadMaster();
        m.summary = `Engineer with ${sourceClaim} of experience.`;
        m.experience[0].roles[0].bullets[0].text = `Built 5 services over ${sourceClaim}.`;
        const t = identityTailored(m);
        if (field === 'bullet') t.experience[0].roles[0].bullets[0].text = claim;
        else t[field] = claim;
        const r = checkTailored(m, t);
        const context = `${claim} against ${sourceClaim}`;
        assert.equal(r.pass, !unsupported, context);
        assert.deepEqual(r.violations, unsupported ? [{
          path: field === 'bullet' ? 'experience[0].roles[0].bullets[0].text' : field,
          rule: field === 'bullet' ? 2 : 7,
          detail: `numbers not supported by the source: ${unsupported}`,
        }] : [], context);
      }
    });
  }
}

test('numericTokens includes glued size, bandwidth, duration, and ordinal units', () => {
  assert.deepEqual(
    numericTokens('500TB 4GB 10Gbps 30d 3yrs 10yr 3rd 1st 7d'),
    ['500', '4', '10', '30', '3', '10', '3', '1', '7'],
  );
  for (const unit of ['kb', 'mb', 'gb', 'tb', 'pb', 'kbps', 'mbps', 'gbps', 'd', 'w', 'wk', 'wks', 'mo', 'yr', 'yrs', 'y', 'st', 'nd', 'rd', 'th']) {
    assert.deepEqual(numericTokens(`42${unit}`), ['42'], unit);
  }
  assert.deepEqual(numericTokens('P99 EC2 S3 50M+ 500k 2bn 8x'), ['p99', '50m', '500k', '2b', '8x']);
});

test('rule 2 rejects unsupported size and ordinal numbers', () => {
  const m = loadMaster();
  m.experience[0].roles[0].bullets[0].text = 'Built a data pipeline.';
  const t = identityTailored(m);
  t.experience[0].roles[0].bullets[0].text = 'Built a data pipeline handling 2TB for the 3rd team.';
  const r = checkTailored(m, t);
  assert.deepEqual(rules(r), [2]);
  assert.equal(r.violations[0].path, 'experience[0].roles[0].bullets[0].text');
  assert.match(r.violations[0].detail, /source: 2, 3$/);
});

test('legitimate rephrasing passes (number words, dropped plus signs, reordered words)', () => {
  const t = identityTailored(master);
  t.experience[0].roles[0].bullets[0].text = 'Built and designed a payment billing platform of six services handling 3M payment events per day in Python and PostgreSQL.';
  t.experience[0].roles[0].bullets[4].text = 'Mentored four engineers through code and design reviews and wrote the API design guide.';
  const r = check(t);
  assert.equal(r.pass, true, JSON.stringify(r.violations));
});

test('rule 1: missing or unknown src', () => {
  const t = identityTailored(master);
  delete t.experience[0].roles[0].bullets[0].src;
  t.experience[0].roles[0].bullets[1].src = 'exp.sr.99';
  const r = check(t);
  assert.equal(r.pass, false);
  assert.deepEqual(rules(r), [1, 1]);
  assert.match(r.violations[1].detail, /unknown source bullet "exp\.sr\.99"/);
});

test('rule 2: a new number and a changed number', () => {
  const t = identityTailored(master);
  t.experience[0].roles[0].bullets[1].text = 'Cut P99 API latency from 900ms to 200ms by adding a Redis cache and rewriting 12 slow SQL queries.';
  t.experience[0].roles[1].bullets[0].text = 'Split a monolithic invoicing service into 4 independently deployable services on Docker and Kubernetes for 7 teams.';
  const r = check(t);
  assert.deepEqual(rules(r), [2, 2]);
  assert.match(r.violations[0].detail, /200/);
  assert.match(r.violations[1].detail, /\b7\b/);
  assert.equal(r.violations[0].path, 'experience[0].roles[0].bullets[1].text');
});

test('rule 3: a new tool, and a tool taken from another role', () => {
  const t = identityTailored(master);
  t.experience[0].roles[0].bullets[0].text = 'Designed and built a billing platform of 6 services that processes 3M+ payment events per day with Python, PostgreSQL and Terraform.';
  t.experience[0].roles[0].bullets[2].text = 'Led a migration of 40 nightly batch jobs to AWS Step Functions and Redshift, cutting compute costs by 35% and failed runs by 80%.';
  const r = check(t);
  assert.deepEqual(rules(r), [3, 3]);
  assert.match(r.violations[0].detail, /Terraform/);
  assert.match(r.violations[1].detail, /Redshift/);
});

test('rule 4: a bullet sourced from another role', () => {
  const t = identityTailored(master);
  t.experience[0].roles[0].bullets.push({ src: 'exp.ii.1', text: 'Split a monolithic invoicing service into 4 independently deployable services on Docker and Kubernetes.' });
  const r = check(t);
  assert.deepEqual(rules(r), [4]);
  assert.match(r.violations[0].detail, /exp\.ii\.1 belongs to Software Engineer II at Globex Corp/);
});

test('rule 3 does not license generic Go from lowercase go live', () => {
  const m = loadMaster();
  m.experience[0].roles[0].bullets[0].text = 'Prepared the service to go live.';
  const t = identityTailored(m);
  t.experience[0].roles[0].bullets[0].text = 'Service rewritten in Go.';
  const r = checkTailored(m, t);
  assert.deepEqual(rules(r), [3]);
  assert.match(r.violations[0].detail, /Go/);
});

test('rule 7 does not license summary Go from lowercase go live in master', () => {
  const m = loadMaster();
  m.experience[0].roles[0].bullets[0].text = 'Prepared the service to go live.';
  const t = identityTailored(m);
  t.summary = 'Engineer building services in Go.';
  const r = checkTailored(m, t);
  assert.deepEqual(r.violations.map((v) => `${v.path}:${v.rule}`), ['summary:7']);
  assert.match(r.violations[0].detail, /Go/);
});

test('master skill Glue still permits lowercase glue in bullet and summary prose', () => {
  const m = loadMaster();
  m.skills[0].items.push('Glue');
  const t = identityTailored(m);
  t.experience[0].roles[0].bullets[0].text = 'Built glue for services.';
  t.summary = 'Engineer building glue for services.';
  const r = checkTailored(m, t);
  assert.equal(r.pass, true, JSON.stringify(r.violations));
});

test('rule 5: unknown employer, role, or project ids are rejected', () => {
  const t = identityTailored(master);
  t.experience[0].roles.push({ id: 'staff', bullets: [{ src: 'exp.sr.1', text: master.experience[0].roles[0].bullets[0].text }] });
  t.projects.push({ id: 'proj.secret', bullets: [] });
  const r = check(t);
  const idViolations = r.violations.filter((v) => v.rule === 5);
  assert.equal(idViolations.length, 2);
  assert.match(idViolations[0].detail, /unknown role id "staff"/);
  assert.match(idViolations[1].detail, /unknown project id "proj\.secret"/);
});

test('rule 6: skill items must exist in master skills', () => {
  const t = identityTailored(master);
  t.skills.push({ group: 'Infra', items: ['terraform', 'docker'] });
  const r = check(t);
  assert.deepEqual(rules(r), [6]);
  assert.match(r.violations[0].detail, /"terraform" is not a master skill/);
});

test('rule 7: headline and summary numbers and tools must exist somewhere in master', () => {
  const t = identityTailored(master);
  t.headline = 'Staff Engineer | Snowflake';
  t.summary = 'Backend engineer with 11+ years building data platforms on AWS and Terraform.';
  const r = check(t);
  assert.deepEqual(r.violations.map((v) => `${v.path}:${v.rule}`), ['headline:7', 'headline:7', 'summary:7', 'summary:7']);
  assert.match(r.violations.map((v) => v.detail).join(' '), /Snowflake.*11.*Terraform/);
});

test('schema: every master role needs a bullet; non-objects fail cleanly', () => {
  const t = identityTailored(master);
  t.experience[0].roles = t.experience[0].roles.slice(0, 2);
  assert.deepEqual(rules(check(t)), ['schema']);
  assert.deepEqual(rules(checkTailored(master, 'nope', { lexicon })), ['schema']);
  assert.deepEqual(rules(checkTailored(master, null, { lexicon })), ['schema']);
});

const schemaCases = [
  ['project bullets must be an array', (t) => { t.projects[0].bullets = 'invalid'; }, ['projects[0].bullets']],
  ['duplicate role and its blank bullet', (t) => {
    t.experience[0].roles.push({ id: 'sr', bullets: [{ src: 'exp.sr.1', text: '' }] });
  }, ['experience[0].roles[3].id', 'experience[0].roles[3].bullets[0].text']],
  ['duplicate employer and its blank bullet', (t) => {
    const duplicate = structuredClone(t.experience[0]);
    duplicate.roles[0].bullets[0].text = '';
    t.experience.push(duplicate);
  }, ['experience[1].id', 'experience[1].roles[0].bullets[0].text']],
  ['duplicate project and its blank bullet', (t) => {
    const duplicate = structuredClone(t.projects[0]);
    duplicate.bullets[0].text = '';
    t.projects.push(duplicate);
  }, ['projects[2].id', 'projects[2].bullets[0].text']],
  ['extra employer with no roles', (t) => { t.experience.push({ id: 'globex', roles: [] }); }, ['experience[1].id']],
  ['unknown employer', (t) => { t.experience.push({ id: 'unknown', roles: [] }); }, ['experience[1].id']],
  ['unknown role', (t) => { t.experience[0].roles.push({ id: 'unknown', bullets: [] }); }, ['experience[0].roles[3].id']],
  ['employer roles must be an array', (t) => { t.experience[0].roles = 'invalid'; }, ['experience[0].roles']],
  ['role bullets must be an array', (t) => { t.experience[0].roles[0].bullets = 'invalid'; }, ['experience[0].roles[0].bullets']],
];

test('schema: each skills group needs at least one item', () => {
  const t = identityTailored(master);
  t.skills.push({ group: 'Empty', items: [] });
  const r = check(t);
  assert.deepEqual(rules(r), ['schema']);
  assert.equal(r.violations[0].path, `skills[${t.skills.length - 1}]`);
});

for (const [name, mutate, paths] of schemaCases) {
  test(`schema: ${name}`, () => {
    const t = identityTailored(master);
    mutate(t);
    const r = check(t);
    assert.equal(r.pass, false);
    const schemaPaths = r.violations.filter((v) => v.rule === 'schema').map((v) => v.path);
    for (const path of paths) assert.ok(schemaPaths.includes(path), `${path}: ${JSON.stringify(r.violations)}`);
  });
}

for (const [name, mutate, path] of [
  ['employer', (t, value) => { t.experience.push(value); }, 'experience[1]'],
  ['role', (t, value) => { t.experience[0].roles.push(value); }, 'experience[0].roles[3]'],
  ['project', (t, value) => { t.projects.push(value); }, 'projects[2]'],
]) {
  test(`schema: every ${name} must be an object`, () => {
    for (const value of [null, [], 'invalid']) {
      const t = identityTailored(master);
      mutate(t, value);
      const r = check(t);
      assert.ok(r.violations.some((v) => v.rule === 'schema' && v.path === path), JSON.stringify(r.violations));
    }
  });
}

// Final-review regressions: each unsupported claim must survive tokenization.
test('unknown numeric suffixes and percentiles cannot disappear or borrow plain counts', () => {
  assert.deepEqual(numericTokens('15sec 30secs $10MM 6mos 5pct 100ppm p99 P95 EC2 S3'),
    ['15sec', '30secs', '10mm', '6mos', '5pct', '100ppm', 'p99', 'p95']);
  const m = loadMaster();
  m.experience[0].roles[0].bullets[0].text = 'Processed 15, 30, 10, 6, 5, 100 and 99 records on EC2 and S3.';
  for (const claim of ['15sec', '30secs', '$10MM', '6mos', '5pct', '100ppm', 'p99', 'P95']) {
    const t = identityTailored(m);
    t.experience[0].roles[0].bullets[0].text = `Processed ${claim}.`;
    assert.ok(checkTailored(m, t).violations.some(v => v.rule === 2), claim);
    m.experience[0].roles[0].bullets[0].text += ` ${claim}`;
    assert.equal(checkTailored(m, t).pass, true, claim);
  }
});

const reviewKeywords = { required: [{ term: 'Rust', alts: [] }, { term: 'Go', alts: [] }], preferred: [{ term: 'Container orchestration', alts: ['Kubernetes'] }] };
for (const field of ['bullet', 'headline', 'summary']) {
  test(`frozen keywords enforce lowercase tools in ${field}`, () => {
    const m = loadMaster();
    m.skills = m.skills.map(g => ({ ...g, items: g.items.filter(x => x !== 'Kubernetes') }));
    const t = identityTailored(m);
    const text = 'built services in rust and go';
    if (field === 'bullet') t.experience[0].roles[0].bullets[0].text = text + ' using kubernetes';
    else t[field] = text;
    const r = checkTailored(m, t, { keywords: reviewKeywords });
    const details = r.violations.filter(v => v.rule === (field === 'bullet' ? 3 : 7)).map(v => v.detail).join(' ');
    assert.match(details, /Rust/);
    assert.match(details, /Go/);
    if (field === 'bullet') assert.match(details, /Kubernetes/);
    m.skills[0].items.push('rust', 'go', 'kubernetes');
    assert.equal(checkTailored(m, t, { keywords: reviewKeywords }).pass, true);
  });
}

for (const title of ['Staff', 'Principal', 'Senior Staff', 'Distinguished', 'Lead', 'Engineering Manager', 'Director', 'Head', 'VP', 'Vice President', 'Architect', 'CTO', 'Chief', 'Senior']) {
  test(`rule 7 rejects unsupported title ${title}`, () => {
    const m = loadMaster();
    m.headline = 'Software Engineer';
    m.experience[0].roles[0].title = 'Software Engineer';
    for (const field of ['headline', 'summary']) {
      const t = identityTailored(m);
      t[field] = `${title} Engineer`;
      assert.ok(checkTailored(m, t).violations.some(v => v.path === field && v.rule === 7), title);
      const supported = structuredClone(m);
      supported.summary += ` ${title} Engineer`;
      assert.equal(checkTailored(supported, t).pass, true, title);
    }
  });
}

for (const word of ['doubled', 'doubling', 'tripled', 'quadrupled', 'halved', 'a decade', 'decades', 'dozens', 'hundreds', 'thousands', 'millions', 'billions']) {
  test(`quantitative claim ${word} needs source support`, () => {
    const m = loadMaster();
    for (const field of ['bullet', 'summary']) {
      const t = identityTailored(m);
      const claim = `Delivered ${word} of improvements.`;
      if (field === 'bullet') t.experience[0].roles[0].bullets[0].text = claim;
      else t[field] = claim;
      assert.ok(checkTailored(m, t).violations.some(v => v.rule === (field === 'bullet' ? 2 : 7)), word);
      const supported = structuredClone(m);
      if (field === 'bullet') supported.experience[0].roles[0].bullets[0].text = claim;
      else supported.summary = claim;
      assert.equal(checkTailored(supported, t).pass, true, word);
    }
  });
}

test('a decade requires tenure, accepts ten years, and cannot license a different duration', () => {
  const m = loadMaster();
  const t = identityTailored(m);
  t.summary = 'A decade of experience.';
  m.summary = 'Built 10 services.';
  assert.ok(checkTailored(m, t).violations.some(v => v.rule === 7));
  for (const source of ['Ten years of experience.', '10+ years of experience.', 'A decade of experience.']) {
    m.summary = source;
    assert.equal(checkTailored(m, t).pass, true, source);
  }
  t.summary = 'Eleven years of experience.';
  assert.equal(checkTailored(m, t).pass, false);
});

test('adversarial tailor: every unsupported claim is caught', () => {
  const t = identityTailored(master);
  t.experience[0].roles[0].bullets[0].text = 'Designed and built a billing platform of 6 services in rust and go, cutting p99 latency to 15sec and doubling throughput, saving $10MM over 6mos.';
  t.headline = 'Staff Engineer | Engineering Manager';
  t.summary = 'A decade of experience leading teams at Google and Stripe.';
  const r = checkTailored(master, t, { keywords: reviewKeywords });
  const details = r.violations.map(v => v.detail).join(' ');
  for (const claim of ['Rust', 'Go', 'p99', '15sec', 'doubling', '10mm', '6mos', 'Staff', 'Engineering Manager', 'decade', 'Google', 'Stripe']) {
    assert.ok(details.toLowerCase().includes(claim.toLowerCase()), `${claim}: ${details}`);
  }
});

test('frozen keyword permission is source bullet plus master skills, including project bullets', () => {
  const m = loadMaster();
  m.projects[0].tech.push('Rust');
  const t = identityTailored(m);
  t.projects[0].bullets[0].text = 'Built services in rust.';
  const r = checkTailored(m, t, { keywords: reviewKeywords });
  assert.ok(r.violations.some(v => v.rule === 3 && v.path === 'projects[0].bullets[0].text' && /Rust/.test(v.detail)));
  m.projects[0].bullets[0].text += ' in rust';
  assert.equal(checkTailored(m, t, { keywords: reviewKeywords }).pass, true);
});
