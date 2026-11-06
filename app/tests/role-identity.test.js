const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const id = require('../lib/jobs/role-identity');

const UUID = '0b6c1f9e-1111-2222-3333-444455556666';

test('every Ashby, Lever, Greenhouse and LinkedIn URL form of one posting maps to one canonical identity', () => {
  const groups = [
    [`https://jobs.ashbyhq.com/acme/${UUID}`, `https://jobs.ashbyhq.com/Acme/${UUID}/application`, `https://jobs.ashbyhq.com/acme/${UUID}/application?utm_source=linkedin`],
    ['https://jobs.lever.co/finch/62ac428a-80ef-4469-9e06-0b87ed4f206f', 'https://jobs.lever.co/finch/62ac428a-80ef-4469-9e06-0b87ed4f206f/apply', 'https://jobs.lever.co/finch/62ac428a-80ef-4469-9e06-0b87ed4f206f/?lever-source=x'],
    ['https://job-boards.greenhouse.io/airbnb/jobs/7528577', 'https://careers.airbnb.com/positions/7528577?gh_jid=7528577', 'https://job-boards.greenhouse.io/embed/job_app?for=airbnb&token=7528577',
      'https://boards.greenhouse.io/airbnb/jobs/7528577?gh_src=abc', 'https://boards.greenhouse.io/airbnb/jobs/7528577?t=gh_src=&gh_jid=7528577'],
    ['https://www.linkedin.com/jobs/view/senior-software-engineer-at-acme-4012345678', 'https://www.linkedin.com/jobs/view/4012345678/', 'https://linkedin.com/jobs/view/4012345678?trk=public_jobs', 'https://www.linkedin.com/jobs/search/?currentJobId=4012345678'],
  ];
  const keys = groups.map(urls => {
    const found = new Set(urls.map(id.postingKey));
    assert.equal(found.size, 1, urls.join(' '));
    assert.ok([...found][0]);
    assert.equal(new Set(urls.map(id.canonicalPostingUrl)).size <= 2, true);
    return [...found][0];
  });
  assert.deepEqual(keys, [`ashby:${UUID}`, 'lever:62ac428a-80ef-4469-9e06-0b87ed4f206f', 'greenhouse:7528577', 'linkedin:4012345678']);
  assert.equal(id.canonicalPostingUrl('https://job-boards.greenhouse.io/embed/job_app?for=airbnb&token=7528577'), 'https://job-boards.greenhouse.io/airbnb/jobs/7528577');
  assert.equal(id.canonicalPostingUrl('https://www.linkedin.com/jobs/view/senior-software-engineer-at-acme-4012345678'), 'https://www.linkedin.com/jobs/view/4012345678/');
  assert.equal(id.canonicalPostingUrl(`https://jobs.ashbyhq.com/Acme/${UUID}/application`), `https://jobs.ashbyhq.com/acme/${UUID}`);
});

test('different postings and careers landing pages never share an identity', () => {
  assert.notEqual(id.postingKey('https://job-boards.greenhouse.io/airbnb/jobs/7528577'), id.postingKey('https://job-boards.greenhouse.io/airbnb/jobs/8074897'));
  for (const url of ['https://cohere.com/careers', 'https://www.anthropic.com/jobs', 'https://openai.com/careers/search/?l=New+York', 'https://runwayml.com/careers/', 'https://jobs.example.com/42', 'not a url', '', null]) {
    assert.equal(id.postingKey(url), null, String(url));
  }
  assert.equal(id.postingKey('https://cursor.com/careers/software-engineer-core-services'), 'url:cursor.com/careers/software-engineer-core-services');
  assert.equal(id.postingKey('https://careers.datadoghq.com/detail/7107437/'), id.postingKey('https://careers.datadoghq.com/detail/7107437'));
  assert.equal(id.postingKey('https://wd1.myworkdaysite.com/recruiting/snapchat/snap/job/Los-Angeles-California/Staff-Software-Engineer--Backend--Level-6_Q426SWEB9/apply'), 'workday:snapchat:q426sweb9');
});

test('title variants collapse but different levels, teams and roles stay distinct', () => {
  const same = [
    ['Sr. Software Engineer', 'Senior Software Engineer'],
    ['Senior Full-Stack Engineer', 'Senior Fullstack Engineer'],
    ['Senior Full Stack Engineer', 'Senior Software Engineer, Full Stack'],
    ['Senior Product Engineer (Frontend) - NYC', 'Senior Product Engineer, Frontend'],
    ['Senior Software Engineer - New York, NY', 'Senior Software Engineer'],
    ['Senior Software Engineer (Remote)', 'Senior Software Engineer'],
    ['Senior / Staff Product Engineer', 'Senior Product Engineer'],
    ['Senior Back-End Engineer, Workflow Systems', 'Senior Backend Engineer, Workflow System'],
    ['Staff Software Engineer, Applied AI Platform Team', 'Staff Software Engineer, Applied AI Platform'],
    ['Senior Software Engineer, Full Stack - NYC', 'Senior Software Engineer, Full-Stack'],
  ];
  for (const [a, b] of same) assert.equal(id.titlesMatch(a, b), true, `${a} ~ ${b}`);
  const different = [
    ['Senior Backend Engineer', 'Staff Backend Engineer'],
    ['Senior Software Engineer, Payments', 'Senior Software Engineer, Identity'],
    ['Senior Software Engineer', 'Senior Software Engineer, Platform'],
    ['Senior Software Engineer I', 'Senior Software Engineer II'],
    ['Founding Engineer', 'Founding Senior Full-Stack Engineer'],
    ['Software Engineer', 'Engineering Manager'],
    ['Senior Frontend Engineer', 'Senior Backend Engineer'],
    ['Product Engineer', 'Senior Product Engineer'],
    ['AI Engineer 5 (GenAI Platform, Agentic Infrastructure)', 'AI Engineer 5 (MLX Agentic AI Gen AI Platform Services)'],
  ];
  for (const [a, b] of different) assert.equal(id.titlesMatch(a, b), false, `${a} != ${b}`);
});

test('company variants match on the same organization only', () => {
  for (const [a, b] of [['Oscar', 'Oscar Health'], ['Cursor (Anysphere)', 'Cursor'], ['Anysphere', 'Cursor (Anysphere)'], ['Scale AI', 'Scale'], ['Two Sigma', 'Two Sigma Investments'], ['Linear', 'Linear, Inc.'], ['Rogo', 'rogo.ai']]) {
    assert.equal(id.companiesMatch(a, b), true, `${a} ~ ${b}`);
  }
  for (const [a, b] of [['Ramp', 'Rippling'], ['Capital One', 'Capital'], ['Oscar Health', 'Clover Health']]) assert.equal(id.companiesMatch(a, b), false, `${a} != ${b}`);
});

test('sameRole uses posting identity first and company plus title otherwise', () => {
  const url = `https://jobs.ashbyhq.com/acme/${UUID}`;
  assert.equal(id.sameRole({ company: 'Acme', role: 'Senior SWE', url }, { company: 'Acme Inc', role: 'Senior Software Engineer, Platform', url: `${url}/application` }), true);
  assert.equal(id.sameRole({ company: 'Acme', role: 'Senior Backend Engineer' }, { company: 'Acme', role: 'Staff Backend Engineer' }), false);
  // A generic employer URL only identifies a posting at the same company.
  const careers = 'https://example.com/careers/senior-software-engineer-platform-team';
  assert.equal(id.sameRole({ company: 'Acme', role: 'Backend', url: careers }, { company: 'Other', role: 'Frontend', url: careers }), false);
});

test('dedupe collapses one role across reports, keeps the newest data and every key it was known by', () => {
  const reports = [
    { date: '2026-10-20', roles: [
      { company: 'Oscar', role: 'Sr. Software Engineer', url: 'https://job-boards.greenhouse.io/oscar/jobs/1234567', fit: 'old fit' },
      { company: 'Acme', role: 'Senior Backend Engineer', url: 'https://jobs.lever.co/acme/62ac428a-80ef-4469-9e06-0b87ed4f206f' },
    ] },
    { date: '2026-11-05', roles: [
      { company: 'Oscar Health', role: 'Senior Software Engineer', url: 'https://www.hioscar.com/careers?gh_jid=1234567', fit: 'new fit' },
      { company: 'Acme', role: 'Staff Backend Engineer', url: 'https://jobs.lever.co/acme/99999999-80ef-4469-9e06-0b87ed4f206f' },
      { company: 'Acme', role: 'Senior Back-End Engineer', url: 'https://jobs.lever.co/acme/62ac428a-80ef-4469-9e06-0b87ed4f206f/apply' },
    ] },
  ];
  const roles = id.dedupeRoles(reports);
  assert.equal(roles.length, 3);
  const oscar = roles.find(role => role.company.startsWith('Oscar'));
  assert.equal(oscar.fit, 'new fit');
  assert.equal(oscar.intelDate, '2026-11-05');
  assert.deepEqual(oscar.keys, ['Oscar Health|Senior Software Engineer', 'Oscar|Sr. Software Engineer']);
  assert.deepEqual(roles.find(role => role.role === 'Senior Back-End Engineer').keys, ['Acme|Senior Back-End Engineer', 'Acme|Senior Backend Engineer']);
  assert.ok(roles.some(role => role.role === 'Staff Backend Engineer'));
});

test('the browser loads the same module the server uses, and the Discover dedupe delegates to it', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.ok(html.indexOf('<script src="/role-identity.js"></script>') < html.indexOf('src="/opportunities.jsx"'));
  assert.match(server, /app\.get\('\/role-identity\.js'[^\n]*lib\/jobs\/role-identity\.js/);
  const context = { window: {}, URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/jobs/role-identity.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(__dirname, '../public/opportunities.jsx'), 'utf8');
  vm.runInNewContext(source.slice(0, source.indexOf('window.mergeJobQuestDrafts')), context);
  const roles = context.window.dedupeJobQuestRoles([{ date: '2026-11-05', roles: [{ company: 'Acme', role: 'Sr. SWE', url: `https://jobs.ashbyhq.com/acme/${UUID}` }] },
    { date: '2026-11-04', roles: [{ company: 'Acme', role: 'Senior Software Engineer', url: `https://jobs.ashbyhq.com/acme/${UUID}/application` }] }]);
  assert.equal(roles.length, 1);
  assert.deepEqual([...roles[0].keys], ['Acme|Sr. SWE', 'Acme|Senior Software Engineer']);
});
