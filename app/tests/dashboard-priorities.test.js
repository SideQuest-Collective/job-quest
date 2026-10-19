const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const home = fs.readFileSync(path.join(__dirname, '../public/dashboard-home.jsx'), 'utf8');
const outreach = fs.readFileSync(path.join(__dirname, '../public/opportunities.jsx'), 'utf8');
const window = {};
vm.runInNewContext(outreach.split('window.Opportunities =')[0] + home.split('window.DashboardHome =')[0], { window, Date, URL });
const now = Date.parse('2026-10-19T12:00:00Z');
const role = (company = 'Example', title = 'Backend Engineer') => ({ company, role: title, url: `https://jobs.example.test/${company}/${encodeURIComponent(title)}`, intelDate: '2026-10-19' });
const review = (extra = {}) => ({ checkedAt: '2026-10-19T11:00:00Z', outcome: 'needs_reply', summary: 'Conversation and sent history checked; a reply is needed.', evidence: [{channel:'email',kind:'conversation',result:'read',checkedAt:'2026-10-19T11:00:00Z'}, {channel:'email',kind:'sent_search',result:'none',checkedAt:'2026-10-19T11:00:00Z'}], ...extra });
const recruiter = (id, extra = {}) => ({ id, kind: 'recruiter', company: 'Other', title: 'Platform Engineer', status: 'ready_for_review', checkedAt: '2026-10-19T09:00:00Z', conversationReview: review(), conversationReviewFresh: true, ...extra });
const priorities = input => Array.from(window.dashboardPriorities({ now, ...input }));

test('actual near interview, due follow-up, later interview, reply and undecided job are grounded and ordered', () => {
  const soon = role('Soon'), later = role('Later'), undecided = role('Undecided');
  const due = recruiter('due', { status: 'snoozed', sentAt: '2026-09-01T12:00:00Z', nextReminderAt: '2026-10-18T12:00:00Z' });
  const reply = recruiter('reply', { lastInboundAt: '2026-10-19T08:00:00Z' });
  const actions = priorities({ nativeRoles: [undecided, later, soon], items: [reply, due], roleTracker: {
    'Soon|Backend Engineer': { stage: 'onsite', timeline: [{ date: '2026-10-20T10:00:00Z', event: 'Confirmed coding interview' }] },
    'Later|Backend Engineer': { stage: 'phone-screen', timeline: [{ date: '2026-10-26T10:00:00Z', event: 'Recruiter call booked' }] },
  }});
  assert.deepEqual(actions.map(action => action.kind), ['interview', 'interview', 'followup', 'reply', 'job']);
  assert.match(actions[0].reason, /Confirmed coding interview.*Oct 20, 2026/);
  assert.match(actions[2].reason, /Conversation verified Oct 19, 2026/);
  assert.match(actions[3].reason, /Conversation and sent history checked.*Conversation verified Oct 19, 2026/);
  assert.match(actions[4].reason, /not saved, dismissed or applied.*Discovered Oct 19, 2026/);
  assert.equal(actions[4].role, undecided);
});

test('saved, dismissed, applied and every tracked role stay out of new job priorities', () => {
  const companies = ['Saved', 'Dismissed', 'Applied', 'Submitted', 'Screen', 'Archived', 'Research', 'Discovered', 'EmptyRecord', 'Fresh'];
  const actions = priorities({ nativeRoles: companies.map(company => role(company)), roleActions: {
    saved: ['Saved|Backend Engineer'], skipped: ['Dismissed|Backend Engineer'], applied: ['Applied|Backend Engineer'],
  }, roleTracker: {
    'Submitted|Backend Engineer': { stage: 'researching', applicationSubmitted: true },
    'Screen|Backend Engineer': { stage: 'phone-screen' }, 'Archived|Backend Engineer': { stage: 'rejected' },
    'Research|Backend Engineer': { stage: 'researching' }, 'Discovered|Backend Engineer': { stage: 'discovered' }, 'EmptyRecord|Backend Engineer': {},
  }});
  assert.deepEqual(actions.map(action => action.role.company).sort(), ['Fresh']);
});

test('held, stale, already sent and future or invalid snoozes stay out; genuinely due reminders return', () => {
  const items = [
    recruiter('hold', { status: 'hold_user', nextReminderAt: '2026-10-01' }), recruiter('dismissed', { status: 'dismissed' }),
    recruiter('stale', { stale: true }), recruiter('closed', { availability: 'Closed by employer' }),
    recruiter('awaiting', { status: 'awaiting_recruiter' }), recruiter('sent', { sentAt: '2026-10-18T12:00:00Z', conversationReview: review({outcome:'awaiting_reply'}) }),
    recruiter('future', { status: 'snoozed', sentAt: '2026-09-01T12:00:00Z', nextReminderAt: '2026-10-20' }), recruiter('missing', { status: 'reconnect_scheduled' }),
    recruiter('invalid', { status: 'snoozed', sentAt: '2026-09-01T12:00:00Z', nextReminderAt: '2026-02-30' }), recruiter('booked', { status: 'meeting_booked' }),
    recruiter('due', { status: 'reconnect_scheduled', sentAt: '2026-09-01T12:00:00Z', nextReminderAt: '2026-10-19T12:00:00Z' }),
    recruiter('new-inbound', { sentAt: '2026-10-18T12:00:00Z', lastInboundAt: '2026-10-19T10:00:00Z' }),
  ];
  const before = JSON.stringify(items);
  const actions = priorities({ items });
  assert.deepEqual(actions.map(action => action.item.id), ['due', 'new-inbound']);
  assert.match(actions[0].reason, /Conversation verified Oct 19, 2026/);
  assert.equal(JSON.stringify(items), before, 'displaying priorities does not change stored decisions');
});

test('a pipeline stage, arbitrary future note, practice, ingested history or past date cannot invent an upcoming interview', () => {
  const cases = [
    { stage: 'onsite' },
    { stage: 'phone-screen', timeline: [{ date: '2026-10-20', event: 'Research interview format' }] },
    { timeline: [{ date: '2026-10-20', event: 'Interview not scheduled' }] },
    { timeline: [{ date: '2026-10-20', event: 'Scheduled mock interview practice' }] },
    { timeline: [{ date: '2026-10-20', event: 'Scheduled interview prep' }] },
    { timeline: [{ key: 'interview:recording', date: '2026-10-20', event: 'Confirmed interview' }] },
    { timeline: [{ date: '2026-10-18', event: 'Scheduled coding interview' }] },
    { timeline: [{ date: '2026-10-20', event: 'Cancelled scheduled interview' }] },
    { timeline: [{ date: 'invalid', event: 'Confirmed interview' }] },
  ];
  for (const tracker of cases) {
    assert.equal(priorities({ nativeRoles: [role()], roleTracker: { 'Example|Backend Engineer': tracker } }).some(action => action.kind === 'interview'), false, JSON.stringify(tracker));
  }
});

test('duplicate roles, records and related outreach collapse to at most five actions without company-only matches', () => {
  const backend = role(), frontend = role('Example', 'Frontend Engineer');
  const contact = recruiter('reply', { company: 'Example', title: 'Recruiter outreach' });
  const actions = priorities({ nativeRoles: [backend, backend, frontend], items: [
    contact, contact, recruiter('alias', { relatedIds: ['reply'] }), ...Array.from({length: 7}, (_, index) => recruiter(`other-${index}`)),
  ] });
  assert.equal(actions.length, 5);
  assert.equal(actions.filter(action => action.item?.id === 'reply' || action.item?.id === 'alias').length, 1);
  assert.equal(priorities({ nativeRoles: [backend, frontend], items: [contact] }).find(action => action.kind === 'reply').role, null);
  const jobs = priorities({ nativeRoles: [backend, backend, frontend] });
  assert.equal(jobs.length, 2);
  const closed = { id: 'closed-backend', kind: 'job', company: 'Example', title: 'Backend Engineer', status: 'closed', sourceLinks: [backend.url] };
  assert.deepEqual(priorities({ nativeRoles: [backend, frontend], items: [closed] }).map(action => action.role.role), ['Frontend Engineer']);
});

test('routine reply backlogs share the five slots with fresh discoveries and fill unused job slots', () => {
  const items = Array.from({length: 8}, (_, index) => recruiter(`reply-${index}`));
  const nativeRoles = [
    { ...role('Older'), intelDate: '2026-10-17' },
    { ...role('Newest'), intelDate: '2026-10-19' },
    { ...role('Middle'), intelDate: '2026-10-18' },
  ];
  const mixed = priorities({ items, nativeRoles });
  assert.deepEqual(mixed.map(action => action.kind), ['reply', 'reply', 'job', 'job', 'job']);
  assert.deepEqual(mixed.filter(action => action.kind === 'job').map(action => action.role.company), ['Newest', 'Middle', 'Older']);
  const oneJob = priorities({ items, nativeRoles: [nativeRoles[1]] });
  assert.deepEqual(oneJob.map(action => action.kind), ['reply', 'reply', 'job', 'reply', 'reply']);
  assert.equal(priorities({ items }).length, 5, 'remaining replies fill slots when no jobs need review');
});

test('upcoming interviews lead while due reminders share space with fresh discoveries', () => {
  const soon = role('Soon');
  const items = [
    ...Array.from({length: 5}, (_, index) => recruiter(`due-${index}`, { status: 'snoozed', sentAt: '2026-09-01T12:00:00Z', nextReminderAt: `2026-10-${String(13 + index).padStart(2, '0')}T12:00:00Z` })),
    ...Array.from({length: 5}, (_, index) => recruiter(`routine-${index}`)),
  ];
  const actions = priorities({ items, nativeRoles: [soon, role('Fresh')], roleTracker: {
    'Soon|Backend Engineer': { timeline: [{ date: '2026-10-20T10:00:00Z', event: 'Confirmed coding interview' }] },
  }});
  assert.deepEqual(actions.map(action => action.kind), ['interview', 'followup', 'followup', 'job', 'followup']);
  assert.deepEqual(actions.filter(action => action.kind === 'followup').map(action => action.item.id), ['due-0', 'due-1', 'due-2']);
});

test('four old due follow-ups and a reply cannot hide all fresh job discoveries', () => {
  const items = [
    ...Array.from({length: 4}, (_, index) => recruiter(`due-${index}`, { status: 'reconnect_scheduled', sentAt: '2026-09-01T12:00:00Z', nextReminderAt: `2026-09-${String(10 + index).padStart(2, '0')}T12:00:00Z` })),
    recruiter('routine'),
  ];
  const nativeRoles = [role('First'), role('Second'), role('Third')];
  const actions = priorities({ items, nativeRoles });
  assert.deepEqual(actions.map(action => action.kind), ['followup', 'followup', 'job', 'job', 'job']);
  assert.deepEqual(actions.slice(0, 2).map(action => action.item.id), ['due-0', 'due-1']);
  assert.match(actions[0].reason, /Conversation verified Oct 19, 2026/);
  assert.doesNotMatch(actions.map(action => action.reason).join(' '), /urgent|deadline|Saved reminder|Sep 10/i);
  const oneJob = priorities({ items, nativeRoles: [nativeRoles[0]] });
  assert.deepEqual(oneJob.map(action => action.kind), ['followup', 'followup', 'job', 'followup', 'followup']);
});

test('strong fit cannot manufacture urgency or outrank dated actions', () => {
  const actions = priorities({ nativeRoles: [{ ...role(), fit: 'Exceptional strong fit. Urgent!' }], items: [recruiter('reply')] });
  assert.deepEqual(actions.map(action => action.kind), ['reply', 'job']);
  assert.doesNotMatch(actions.map(action => `${action.label} ${action.reason}`).join(' '), /urgent|deadline|strong fit/i);
});

test('dashboard primary actions pass the exact object to its workflow, with practice and progress secondary', () => {
  const handler = home.match(/  const openAction = item => \{[\s\S]*?\n  \};/)[0];
  const calls = [], callbacks = ['onReviewJob', 'onOpenRole', 'onOpenOutreach'];
  const open = new Function(...callbacks, 'setPage', `${handler}\nreturn openAction;`)(...callbacks.map(name => value => calls.push([name, value])), value => calls.push(['page', value]));
  const exactRole = role(), exactItem = recruiter('reply');
  open({ kind: 'job', role: exactRole }); open({ kind: 'interview', role: exactRole }); open({ kind: 'reply', item: exactItem });
  assert.deepEqual(calls, [['onReviewJob', exactRole], ['onOpenRole', exactRole], ['onOpenOutreach', exactItem]]);
  assert.ok(home.indexOf('id="dashboard-priorities"') < home.indexOf('id="dashboard-today"'));
  assert.ok(home.indexOf('id="dashboard-today"') < home.indexOf('id="dashboard-progress"'));
  assert.match(home, /onClick=\{\(\)=>openAction\(item\)\}/);
  assert.doesNotMatch(home, /Jobs &amp; recruiter contacts|dashboardHighlights|id="dashboard-opportunities"/);
});


test('saved reminder dates cannot produce actions without current verified conversation evidence', () => {
  const due = {status:'reconnect_scheduled',sentAt:'2026-10-01T12:00:00Z',nextReminderAt:'2026-10-06'};
  const cases = [
    {conversationReview:undefined,conversationReviewFresh:false},
    {conversationReview:review({checkedAt:'2026-10-18T11:59:59Z'})},
    {conversationReview:review({evidence:[]})},
    {conversationReviewFresh:false},
    {conversationReview:review({outcome:'unverified',summary:'LinkedIn could not be read.'})},
    {lastInboundAt:'2026-10-19T11:01:00Z'},
    {sentAt:'2026-10-19T11:01:00Z'},
    {conversationReview:review({checkedAt:'2026-10-20T11:00:00Z'})},
  ];
  for (const extra of cases) assert.equal(priorities({items:[recruiter('due',{...due,...extra})]}).length,0,JSON.stringify(extra));
  for (const outcome of ['awaiting_reply','booked','closed']) {
    const item = recruiter('due',{...due,conversationReview:review({outcome})});
    const original=JSON.stringify(item);
    assert.equal(priorities({items:[item]}).length,0,outcome);
    assert.equal(JSON.stringify(item),original,'suppression preserves reminder and draft history');
  }
});

test('fresh evidence labels a new inbound reply accurately even when a saved reminder is old', () => {
  const item=recruiter('new-inbound',{status:'awaiting_recruiter',sentAt:'2026-10-01T12:00:00Z',lastInboundAt:'2026-10-19T10:00:00Z',nextReminderAt:'2026-10-06'});
  const [action]=priorities({items:[item]});
  assert.equal(action.kind,'reply');
  assert.equal(action.action,'Review reply');
  assert.doesNotMatch(action.reason,/due|urgent|Check the conversation before replying/);
  const [firstReply]=priorities({items:[recruiter('unsent',{status:'snoozed',nextReminderAt:'2026-10-06'})]});
  assert.equal(firstReply.kind,'reply','an elapsed snooze does not imply a previous reply was sent');
});
