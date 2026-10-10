const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { registerOpportunityRoutes, editQueueItem } = require(process.env.OPPORTUNITIES_ROUTES_SOURCE || '../lib/opportunities/routes');

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
  action('sent', { sentChannel: 'email' });
  assert.equal(item.status, 'awaiting_recruiter');
  assert.ok(item.sentAt);
  assert.equal(item.nextReminderAt, null);
  const queue = JSON.parse(fs.readFileSync(f.queuePath));
  assert.equal(queue.items[0].verification, 'user_reported');
  assert.equal(item.verification, 'user_reported');
  assert.equal(item.userReportedReplyStatus, 'sent');
  assert.equal(item.userReportedReplyStatusAt, item.sentAt);
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
  const source = fs.readFileSync(process.env.OPPORTUNITIES_UI_SOURCE || path.join(__dirname, '../public/opportunities.jsx'), 'utf8');
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

test('different-ID cross-channel outreach merges only with sender, role and conversation evidence', t => {
  const shared = 'https://mail.example.com/thread/42';
  const f = fixture(t, { brief: { opportunities: [
    { id: 'mail', kind: 'recruiter', company: 'Example', title: 'Backend Engineer', recruiter: 'Alex Recruiter', sourceAccount: 'work', sourceUrl: shared },
    { id: 'linkedin', kind: 'recruiter', company: 'Example', title: 'Backend Engineer', recruiter: 'Alex Recruiter', sourceAccount: 'personal', channel: 'linkedin', sourceUrl: 'https://linkedin.com/message/42' },
  ] }, queue: { items: [{ id: 'linkedin', company: 'Example', title: 'Backend Engineer', recruiter: 'Alex Recruiter', status: 'ready_for_review', draftReply: 'Thanks, happy to chat.', emailSourceUrl: shared, sourceAccount: 'personal', channel: 'linkedin' }] } });
  const before = fs.readFileSync(f.queuePath, 'utf8');
  const cards = invoke(f, 'get', '/api/opportunities').body.opportunities;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'linkedin', 'editable identity and revision remain authoritative');
  assert.deepEqual(cards[0].relatedIds, ['mail', 'linkedin']);
  assert.deepEqual(cards[0].sourceAccounts, ['work', 'personal']);
  assert.ok(cards[0].sourceProvenance.some(source => source.account === 'personal' && source.channel === 'linkedin'));
  assert.deepEqual(cards[0].sourceLinks, [shared, 'https://linkedin.com/message/42']);
  assert.equal(fs.readFileSync(f.queuePath, 'utf8'), before, 'read reconciliation never rewrites queue decisions');
});

test('company or booking URL alone does not combine distinct roles, senders or unsupported matches', t => {
  const base = { kind: 'recruiter', company: 'Example', title: 'Backend Engineer', recruiter: 'Alex', location: 'NYC', schedulingUrl: 'https://cal.example.com/alex' };
  const f = fixture(t, { brief: { opportunities: [
    { ...base, id: 'a', sourceUrl: 'https://mail.example.com/a' },
    { ...base, id: 'role', title: 'Frontend Engineer', sourceUrl: 'https://mail.example.com/b' },
    { ...base, id: 'sender', recruiter: 'Sam', sourceUrl: 'https://mail.example.com/c' },
    { ...base, id: 'unknown', recruiter: '', sourceUrl: 'https://mail.example.com/d' },
    { ...base, id: 'location', location: 'London', sourceUrl: 'https://mail.example.com/e' },
  ] }, queue: { items: [] } });
  assert.equal(invoke(f, 'get', '/api/opportunities').body.opportunities.length, 5);
});

test('matching editable records and conflicting drafts retain separate decisions and conflict metadata', t => {
  const base = { kind: 'recruiter', company: 'Example', title: 'Engineer', recruiter: 'Alex', sourceUrl: 'https://mail.example.com/same' };
  const f = fixture(t, { brief: { opportunities: [{ ...base, id: 'a' }, { ...base, id: 'b' }] }, queue: { items: [
    { ...base, id: 'a', status: 'hold_user', draftReply: 'Edited hold draft', sourceAccount: 'work' },
    { ...base, id: 'b', status: 'awaiting_recruiter', sentAt: '2026-10-01T12:00:00Z', draftReply: 'Sent draft', sourceAccount: 'personal' },
  ] } });
  const cards = invoke(f, 'get', '/api/opportunities').body.opportunities;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].status, 'hold_user');
  assert.equal(cards[1].status, 'awaiting_recruiter');
  assert.equal(cards[0].draftReply, 'Edited hold draft');
  assert.ok(cards[1].sentAt);
  assert.equal(cards[0].duplicateConflicts[0].id, 'b');
  assert.equal(cards[1].duplicateConflicts[0].id, 'a');
  assert.notEqual(cards[0].revision, cards[1].revision);
});

test('queue-only records retain account, channel and source provenance', t => {
  const f = fixture(t, { brief: { opportunities: [] }, queue: { items: [{ id: 'only', accountId: 'secondary', channel: 'gmail', sourceUrl: 'https://mail.example.com/only', status: 'hold_user' }] } });
  const card = invoke(f, 'get', '/api/opportunities').body.opportunities[0];
  assert.equal(card.sourceAccount, 'secondary');
  assert.deepEqual(card.sourceAccounts, ['secondary']);
  assert.equal(card.sourceProvenance[0].channel, 'gmail');
  assert.deepEqual(card.sourceProvenance[0].links, ['https://mail.example.com/only']);
});


test('a shared inbox landing page is not evidence of the same conversation', t => {
  const base = { kind: 'recruiter', company: 'Example', title: 'Engineer', recruiter: 'Alex', sourceUrl: 'https://mail.google.com/mail/u/0/#inbox' };
  const f = fixture(t, { brief: { opportunities: [{ ...base, id: 'a' }, { ...base, id: 'b' }] }, queue: { items: [] } });
  assert.equal(invoke(f, 'get', '/api/opportunities').body.opportunities.length, 2);
});


test('source verification provenance is read without inferring it from sent status', t => {
  const f = fixture(t, { brief: { opportunities: [] }, queue: { items: [
    { id: 'source', status: 'awaiting_recruiter', sentAt: '2026-10-01T12:00:00Z', verification: 'sent_thread_checked', verifiedAt: '2026-10-02T12:00:00Z' },
    { id: 'unknown', status: 'awaiting_recruiter', sentAt: '2026-10-01T12:00:00Z' },
  ] } });
  const cards = invoke(f, 'get', '/api/opportunities').body.opportunities;
  assert.equal(cards[0].verification, 'sent_thread_checked');
  assert.equal(cards[0].verifiedAt, '2026-10-02T12:00:00Z');
  assert.equal(cards[0].userReportedReplyStatus, null);
  assert.equal(cards[1].verification, null);
  assert.equal(cards[1].verifiedAt, null);
});


test('reply channel recommendations honor explicit recruiter and ongoing conversation signals before content needs', t => {
  const f = fixture(t, { brief: { opportunities: [] }, queue: { items: [
    { id: 'requested', channel: 'linkedin', sourceUrl: 'https://linkedin.com/message/requested', emailSourceUrl: 'https://mail.example.com/requested', requestedReplyChannel: 'linkedin', needsResume: true },
    { id: 'ongoing', channel: 'gmail', sourceUrl: 'https://mail.example.com/ongoing', ongoingSubstantiveChannel: 'email', responseType: 'quick' },
    { id: 'documents', channel: 'linkedin', sourceUrl: 'https://linkedin.com/message/docs', emailSourceUrl: 'https://mail.example.com/docs', needsDocuments: true },
    { id: 'quick', channel: 'linkedin', sourceUrl: 'https://linkedin.com/message/quick', responseType: 'scheduled-time' },
    { id: 'unknown', channel: 'linkedin', sourceUrl: 'https://linkedin.com/message/unknown' },
  ] } });
  const cards = invoke(f, 'get', '/api/opportunities').body.opportunities;
  assert.deepEqual(cards.map(c => c.recommendedReplyChannel), ['linkedin', 'email', 'email', 'linkedin', 'linkedin']);
  assert.equal(cards[0].recommendedReplyUrl, 'https://linkedin.com/message/requested');
  assert.match(cards[0].replyChannelReason, /explicitly requested/);
  assert.match(cards[1].replyChannelReason, /ongoing substantive/);
  assert.equal(cards[2].recommendedReplyUrl, 'https://mail.example.com/docs');
  assert.ok(cards[2].sourceLinks.includes('https://linkedin.com/message/docs'));
  assert.ok(cards[2].sourceLinks.includes('https://mail.example.com/docs'));
  assert.equal(cards[4].recommendedReplyUrl, 'https://linkedin.com/message/unknown');
  assert.match(cards[4].replyChannelReason, /saved LinkedIn/);
});

test('merged source channel recommendations retain explicit signals and never invent a direct reply link', t => {
  const base = { kind: 'recruiter', company: 'Example', title: 'Engineer', recruiter: 'Alex', sourceUrl: 'https://mail.example.com/thread' };
  const f = fixture(t, { brief: { opportunities: [{ ...base, id: 'mail', channel: 'gmail' }, { ...base, id: 'linkedin', requestedReplyChannel: 'linkedin', needsResume: true }] }, queue: { items: [] } });
  const card = invoke(f, 'get', '/api/opportunities').body.opportunities[0];
  assert.equal(card.recommendedReplyChannel, 'linkedin');
  assert.equal(card.recommendedReplyUrl, null, 'email source is not a LinkedIn reply link');
  assert.equal(card.relatedIds.length, 2);
});


test('merge retains calendar fallback, source-link arrays and trusted recruiter recipient identity', t => {
  const base = { kind: 'recruiter', company: 'Example', title: 'Engineer', recipientEmail: 'alex@example.com', sourceLinks: ['https://mail.example.com/shared'] };
  const f = fixture(t, { brief: { opportunities: [
    { ...base, id: 'email', sourceUrl: 'https://mail.example.com/a', schedulingUrl: 'https://cal.example.com/alex' },
    { ...base, id: 'linkedin', sourceUrl: 'https://linkedin.com/message/a' },
  ] }, queue: { items: [{ ...base, id: 'linkedin', status: 'ready_for_review' }] } });
  const card = invoke(f, 'get', '/api/opportunities').body.opportunities[0];
  assert.equal(card.schedulingUrl, 'https://cal.example.com/alex');
  assert.equal(card.relatedIds.length, 2);
  assert.ok(card.sourceLinks.includes('https://mail.example.com/shared'));
});

test('shared LinkedIn notification recipients are not recruiter identities', t => {
  const base = { kind: 'recruiter', company: 'Example', title: 'Engineer', recipientEmail: 'inmail-hit-reply@linkedin.com', sourceUrl: 'https://mail.example.com/shared' };
  const f = fixture(t, { brief: { opportunities: [{ ...base, id: 'a' }, { ...base, id: 'b' }] }, queue: { items: [] } });
  assert.equal(invoke(f, 'get', '/api/opportunities').body.opportunities.length, 2);
});

test('reopening clears an old reminder date without erasing saved context or reminder history', () => {
  const original = { id: 'held', status: 'hold_after_reminders', nextReminderAt: '2090-01-01T12:00:00Z', reminderCount: 2, lastNudgedAt: '2026-10-01T12:00:00Z', draftReply: 'Edited reply', followUpType: 'future_opportunities', custom: { preserve: true } };
  const now = '2026-10-09T12:00:00Z';
  const next = editQueueItem(original, { action: 'reopen' }, now);
  assert.equal(next.status, 'ready_for_review');
  assert.equal(next.nextReminderAt, null);
  assert.equal(next.reviewResumedAt, now);
  for (const field of ['draftReply', 'followUpType', 'custom']) assert.deepEqual(next[field], original[field]);
  assert.equal(next.reminderCount, 0);
  assert.equal(next.lastNudgedAt, null);
  assert.deepEqual(next.reminderResumeHistory, [{ resumedAt: now, previousStatus: original.status, nextReminderAt: original.nextReminderAt, reminderCount: original.reminderCount, lastNudgedAt: original.lastNudgedAt }]);
  assert.throws(() => editQueueItem({ ...original, reminderResumeHistory: {} }, { action: 'reopen' }, now), /Stored reminder history/);
  assert.equal(original.nextReminderAt, '2090-01-01T12:00:00Z');
});

test('user-reported sent replies require the actual chosen channel and preserve actual sent time separately from report time', () => {
  const now = '2026-10-09T12:00:00Z';
  const original = { id: 'reply', status: 'ready_for_review', nextReminderAt: '2026-10-10T12:00:00Z', draftReply: 'My reply', sourceUrl: 'https://example.com/thread', schedulingUrl: 'https://example.com/calendar' };
  assert.throws(() => editQueueItem(original, { action: 'sent' }, now), /Choose the channel/);
  for (const sentAt of ['2090-01-01T00:00:00Z', 'invalid', '2026-10-08T12:00:00', 12]) assert.throws(() => editQueueItem(original, { action: 'sent', sentChannel: 'email', sentAt }, now), /valid sent time/);
  const next = editQueueItem(original, { action: 'sent', sentChannel: 'linkedin', sentAt: '2026-10-08T10:30:00-04:00' }, now);
  assert.equal(next.sentAt, '2026-10-08T14:30:00.000Z');
  assert.equal(next.sentChannel, 'linkedin');
  assert.equal(next.userReportedReplyChannel, 'linkedin');
  assert.equal(next.userReportedReplyStatusAt, now);
  assert.equal(next.verification, 'user_reported');
  assert.equal(next.status, 'awaiting_recruiter');
  assert.equal(next.nextReminderAt, null);
  assert.equal(next.schedulingUrl, original.schedulingUrl);
  assert.equal(next.draftReply, original.draftReply);
  for (const action of ['snooze', 'hold', 'reopen']) assert.throws(() => editQueueItem(next, { action }, now), /already sent or booked/);
  assert.equal(original.status, 'ready_for_review');
  assert.equal(editQueueItem(original, { action: 'sent', sentChannel: 'email' }, now).sentAt, '2026-10-09T12:00:00.000Z');
});

test('actual saved draft and source evidence guide reply choices without turning notifications into reply destinations', t => {
  const f = fixture(t, { brief: { opportunities: [] }, queue: { items: [
    { id: 'notification', channel: 'linkedin_email', sourceUrl: 'https://www.linkedin.com/messaging/thread/1', emailSourceUrl: 'https://mail.google.com/mail/u/0/#all/notice', draftReply: 'Thanks! I would love to chat.' },
    { id: 'documents-draft', channel: 'gmail', sourceUrl: 'https://mail.google.com/mail/u/0/#all/docs', linkedinSourceUrl: 'https://www.linkedin.com/messaging/thread/2', draftReply: 'Thanks! I can share my resume.', requestedReplyChannel: 'linkedin' },
    { id: 'long-draft', channel: 'gmail', sourceUrl: 'https://mail.google.com/mail/u/0/#all/long', linkedinSourceUrl: 'https://www.linkedin.com/messaging/thread/3', draftReply: 'A detailed response. '.repeat(20) },
    { id: 'inconsistent-channel', channel: 'gmail', sourceUrl: 'https://www.linkedin.com/messaging/thread/4', draftReply: 'Thanks! Let’s chat.' },
  ] } });
  const cards = invoke(f, 'get', '/api/opportunities').body.opportunities;
  assert.equal(cards[0].recommendedReplyChannel, 'linkedin');
  assert.deepEqual(cards[0].replySources.find(source => source.channel === 'email'), { channel: 'email', url: 'https://mail.google.com/mail/u/0/#all/notice', canReply: false });
  assert.match(cards[0].replyChannelReason, /brief reply/);
  assert.equal(cards[1].recommendedReplyChannel, 'linkedin', 'explicit request wins over draft references');
  assert.equal(cards[1].replySources.length, 2);
  assert.equal(cards[2].recommendedReplyChannel, 'email');
  assert.match(cards[2].replyChannelReason, /longer draft/);
  assert.equal(cards[3].recommendedReplyChannel, 'linkedin');
  assert.equal(cards[3].replySources.length, 1, 'an old channel label must not relabel a LinkedIn URL as email');
});

test('recruiter related listing remains a typed source link through snapshot and draft edits', t => {
  const f = fixture(t, { queue: { items: [{ id: 'role-1', draftReply: 'Saved reply', relatedRoleUrl: 'https://jobs.example.com/role' }] } });
  const card = invoke(f, 'get', '/api/opportunities').body.opportunities.find(item => item.id === 'role-1');
  assert.equal(card.relatedRoleUrl, 'https://jobs.example.com/role');
  assert.ok(card.sourceLinks.includes(card.relatedRoleUrl));
  const saved = invoke(f, 'patch', '/api/opportunities/:id', { action: 'draft', revision: card.revision, draftReply: 'Edited reply' }, card.id);
  assert.equal(saved.status, 200);
  assert.equal(invoke(f, 'get', '/api/opportunities').body.opportunities.find(item => item.id === card.id).relatedRoleUrl, card.relatedRoleUrl);
});
