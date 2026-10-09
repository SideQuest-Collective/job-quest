const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { registerOpportunityRoutes } = require('../lib/opportunities/routes');

function fixture(t, { brief = {}, queue = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquest-opportunities-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const briefPath = path.join(root, 'brief.json');
  const queuePath = path.join(root, 'queue.json');
  fs.writeFileSync(briefPath, JSON.stringify({
    generatedAt: '2026-10-08T12:00:00Z', summary: 'Review locally',
    sources: [{ name: 'Mail account', status: 'blocked', checkedAt: '2026-10-08T12:00:00Z', detail: 'Access interrupted' }],
    opportunities: [{ id: 'role-1', kind: 'recruiter', title: 'Engineer', company: 'Example', location: 'Remote',
      sourceUrl: 'https://example.com/message', draftReply: 'Old draft', checkedAt: '2026-10-08T12:00:00Z',
      nextAction: 'Review message' },
    { id: 'role-1', kind: 'recruiter', title: 'Duplicate', company: 'Example', sourceUrl: 'https://example.com/duplicate' },
    { id: 'job-1', kind: 'job', title: 'Developer', company: 'Other', sourceUrl: 'https://example.com/job' }],
    research: [], ...brief,
  }));
  fs.writeFileSync(queuePath, JSON.stringify({
    version: 1, updatedAt: '2026-10-08T12:00:00Z', unrelated: { preserve: true },
    items: [{ id: 'role-1', status: 'ready_for_review', draftReply: 'Edited draft',
      sourceUrl: 'https://example.com/message', emailSourceUrl: 'https://example.com/email',
      relatedThreadIds: ['https://example.com/thread', 'unusable-id'],
      schedulingUrl: 'https://example.com/calendar', custom: { preserve: true } }],
    holds: [], ...queue,
  }));
  const handlers = {};
  const app = Object.fromEntries(['get', 'patch', 'put'].map(method => [method, (route, handler) => { handlers[`${method} ${route}`] = handler; }]));
  registerOpportunityRoutes(app, { dataDir: root, briefPath, queuePath });
  return { handlers, root, briefPath, queuePath };
}

function invoke(f, method, route, body, id) {
  let status = 200, result;
  const res = { status(code) { status = code; return this; }, json(value) { result = value; return this; } };
  f.handlers[`${method} ${route}`]({ body, params: { id } }, res);
  return { status, body: result };
}

test('read-only bridge merges stable IDs, preserves all source links, and exposes blocked coverage', t => {
  const f = fixture(t);
  const { body } = invoke(f, 'get', '/api/opportunities');
  assert.equal(body.briefState, 'ready');
  assert.equal(body.queueState, 'ready');
  assert.equal(body.sources[0].status, 'blocked');
  assert.equal(body.opportunities.length, 2);
  const recruiter = body.opportunities.find(item => item.id === 'role-1');
  assert.equal(recruiter.draftReply, 'Edited draft');
  assert.deepEqual(recruiter.sourceLinks, [
    'https://example.com/message', 'https://example.com/email', 'https://example.com/thread', 'https://example.com/duplicate',
  ]);
  assert.equal(recruiter.editable, true);
  assert.equal(body.opportunities.find(item => item.id === 'job-1').editable, false);
  assert.equal(recruiter.sourceAccount, null);
});

test('edits require a fresh record revision and preserve queue fields outside the edited item', t => {
  const f = fixture(t);
  const initial = invoke(f, 'get', '/api/opportunities').body.opportunities[0];
  const response = invoke(f, 'patch', '/api/opportunities/:id', {
    revision: initial.revision, action: 'draft', draftReply: 'New user draft',
  }, 'role-1');
  assert.equal(response.status, 200);
  assert.equal(response.body.item.draftReply, 'New user draft');
  const queue = JSON.parse(fs.readFileSync(f.queuePath));
  assert.deepEqual(queue.unrelated, { preserve: true });
  assert.deepEqual(queue.items[0].custom, { preserve: true });
  assert.equal(queue.items[0].draftReply, 'New user draft');
  assert.equal(fs.statSync(f.queuePath).mode & 0o777, 0o600);
  const stale = invoke(f, 'patch', '/api/opportunities/:id', {
    revision: initial.revision, action: 'hold',
  }, 'role-1');
  assert.equal(stale.status, 409);
  assert.equal(JSON.parse(fs.readFileSync(f.queuePath)).items[0].status, 'ready_for_review');
});

test('snooze, pause, resume, and sent are explicit; opening and copying have no mutation endpoint', t => {
  const f = fixture(t);
  let item = invoke(f, 'get', '/api/opportunities').body.opportunities[0];
  const action = (name, extra = {}) => {
    const result = invoke(f, 'patch', '/api/opportunities/:id', { revision: item.revision, action: name, ...extra }, 'role-1');
    assert.equal(result.status, 200);
    item = invoke(f, 'get', '/api/opportunities').body.opportunities[0];
    return result.body.item;
  };
  action('snooze', { until: '2090-01-01T12:00:00Z' });
  assert.equal(item.status, 'snoozed');
  action('hold');
  assert.equal(item.status, 'hold_user');
  action('reopen');
  assert.equal(item.status, 'ready_for_review');
  action('sent');
  assert.equal(item.status, 'awaiting_recruiter');
  assert.ok(item.sentAt);
  assert.equal(item.nextReminderAt, null);
  const queue = JSON.parse(fs.readFileSync(f.queuePath));
  assert.equal(queue.items[0].verification, 'user_reported');
  const repeat = invoke(f, 'patch', '/api/opportunities/:id', { revision: item.revision, action: 'sent' }, 'role-1');
  assert.equal(repeat.status, 400);
});

test('account selection is revision-controlled and does not claim connection or scans', t => {
  const f = fixture(t);
  const initial = invoke(f, 'get', '/api/opportunities').body;
  const accounts = [{ id: 'primary', kind: 'gmail', label: 'Primary' },
    { id: 'linkedin_notice', kind: 'linkedin_email', label: 'LinkedIn notices in primary email' }];
  const response = invoke(f, 'put', '/api/opportunities/accounts', { revision: initial.accountsRevision, accounts });
  assert.equal(response.status, 200);
  const refreshed = invoke(f, 'get', '/api/opportunities').body;
  assert.deepEqual(refreshed.accounts, accounts.map(account => ({ ...account,
    accessStatus: 'unverified', accessCheckedAt: null, accessDetail: '', sourceName: '',
  })));
  assert.equal(refreshed.sources[0].accountId, null);
  const stale = invoke(f, 'put', '/api/opportunities/accounts', { revision: initial.accountsRevision, accounts: [] });
  assert.equal(stale.status, 409);
  assert.equal(fs.statSync(path.join(f.root, 'opportunity-accounts.json')).mode & 0o777, 0o600);
  const verified = invoke(f, 'put', '/api/opportunities/accounts', {
    revision: refreshed.accountsRevision,
    accounts: [{ ...refreshed.accounts[0], accessStatus: 'verified', accessCheckedAt: '2026-10-08T13:00:00Z', accessDetail: 'Connector profile tested', sourceName: 'Mail account' }, refreshed.accounts[1]],
  });
  assert.equal(verified.status, 200);
  const final = invoke(f, 'get', '/api/opportunities').body;
  assert.equal(final.accounts[0].accessStatus, 'verified');
  assert.equal(final.accounts[0].sourceName, 'Mail account');
  assert.equal(final.sources[0].accountId, null, 'connector test does not imply completed account scan');
  const duplicate = invoke(f, 'put', '/api/opportunities/accounts', {
    revision: final.accountsRevision,
    accounts: [...final.accounts, { id: 'duplicate', kind: 'gmail', label: 'primary' }],
  });
  assert.equal(duplicate.status, 400);
});

test('missing local files show an unavailable state rather than an empty successful scan', t => {
  const f = fixture(t);
  fs.unlinkSync(f.briefPath);
  fs.unlinkSync(f.queuePath);
  const body = invoke(f, 'get', '/api/opportunities').body;
  assert.equal(body.briefState, 'missing');
  assert.equal(body.queueState, 'missing');
  assert.deepEqual(body.opportunities, []);
  assert.deepEqual(body.sources, []);
});

test('malformed input is reported as unreadable and never treated as a completed empty review', t => {
  const f = fixture(t);
  fs.writeFileSync(f.briefPath, '{broken json');
  let body = invoke(f, 'get', '/api/opportunities').body;
  assert.equal(body.briefState, 'unreadable');
  assert.equal(body.opportunities.length, 1, 'queue history remains visible when the brief is unreadable');
  assert.equal(body.opportunities[0].queueOnly, true);
  fs.writeFileSync(f.briefPath, JSON.stringify({ generatedAt: '2026-10-08T12:00:00Z' }));
  body = invoke(f, 'get', '/api/opportunities').body;
  assert.equal(body.briefState, 'unreadable');
  fs.writeFileSync(f.queuePath, '{broken json');
  const update = invoke(f, 'patch', '/api/opportunities/:id', { revision: 'any', action: 'hold' }, 'role-1');
  assert.equal(update.status, 503);
});

test('canonical listing dedup merges changed IDs and tracking URLs, but keeps distinct roles at one company', t => {
  const f = fixture(t, { brief: { opportunities: [
    { id: 'job-old', kind: 'job', title: 'Backend Engineer', company: 'Example', checkedAt: '2026-10-06T12:00:00Z', sourceUrl: 'https://jobs.example.com/42?utm_source=alert' },
    { id: 'job-new', kind: 'job', title: 'Backend Engineer', company: 'Example', checkedAt: '2026-10-08T12:00:00Z', sourceUrl: 'https://jobs.example.com/42' },
    { id: 'job-other', kind: 'job', title: 'Frontend Engineer', company: 'Example', checkedAt: '2026-10-08T12:00:00Z', sourceUrl: 'https://jobs.example.com/42' },
  ] } });
  const jobs = invoke(f, 'get', '/api/opportunities').body.opportunities.filter(item => item.kind === 'job');
  assert.equal(jobs.length, 2);
  const backend = jobs.find(item => item.title === 'Backend Engineer');
  assert.equal(backend.id, 'job-new');
  assert.deepEqual(backend.relatedIds, ['job-old', 'job-new']);
  assert.equal(backend.sourceLinks.length, 2);
  assert.ok(jobs.some(item => item.title === 'Frontend Engineer'));
});

test('queue-only unresolved outreach remains visible without inventing a due reply', t => {
  const f = fixture(t, { queue: { items: [
    { id: 'role-1', status: 'ready_for_review', draftReply: 'Edited draft' },
    { id: 'older', company: 'Older Co', status: 'ready_for_review', draftReply: 'Saved', sourceUrl: 'https://example.com/older', reason: 'Review source' },
  ], holds: [{ id: 'paused', company: 'Paused Co', status: 'hold_preference', sourceUrl: 'https://example.com/paused' }] } });
  const cards = invoke(f, 'get', '/api/opportunities').body.opportunities;
  assert.equal(cards.length, 4);
  const older = cards.find(card => card.id === 'older');
  assert.equal(older.queueOnly, true);
  assert.equal(older.nextAction, 'Review the original conversation before acting.');
  assert.equal(cards.find(card => card.id === 'paused').status, 'hold_preference');
});

test('native reports dedupe canonical URLs and local draft refresh preserves unsaved edits', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/opportunities.jsx'), 'utf8');
  const context = { window: {}, URL };
  vm.runInNewContext(source.slice(0, source.indexOf('window.Opportunities =')), context);
  const roles = context.window.dedupeJobQuestRoles([
    { date: '2026-10-08', roles: [
      { company: 'Example', role: 'Backend', url: 'https://jobs.example.com/42?utm_source=daily' },
      { company: 'Example', role: 'Frontend', url: 'https://jobs.example.com/42' },
    ] },
    { date: '2026-10-07', roles: [{ company: 'Example', role: 'Backend', url: 'https://jobs.example.com/42' }] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(roles.map(role => role.role))), ['Backend', 'Frontend']);
  const drafts = context.window.mergeJobQuestDrafts(
    { a: 'Local edit', b: 'Old B' }, { a: 'Old A', b: 'Old B' },
    [{ id: 'a', draftReply: 'New server A' }, { id: 'b', draftReply: 'New server B' }],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(drafts)), { a: 'Local edit', b: 'New server B' });
  const now = Date.parse('2026-10-08T12:00:00Z');
  const cards = [
    { id: 'ready', kind: 'recruiter', status: 'ready_for_review' },
    { id: 'snoozed', kind: 'recruiter', status: 'snoozed' },
    { id: 'held', kind: 'recruiter', status: 'hold_preference' },
    { id: 'skipped', kind: 'recruiter', status: 'declined' },
    { id: 'reconnect', kind: 'recruiter', status: 'reconnect_scheduled' },
    { id: 'future', kind: 'recruiter', status: 'ready_for_review', nextReminderAt: '2026-10-09T12:00:00Z' },
    { id: 'sent', kind: 'recruiter', status: 'awaiting_recruiter' },
    { id: 'job', kind: 'job' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.filterJobQuestCards(cards, 'outreach', true, now).map(card => card.id))), ['ready']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.filterJobQuestCards(cards, 'held', false, now).map(card => card.id))).sort(), ['held', 'reconnect', 'skipped', 'snoozed']);
});
