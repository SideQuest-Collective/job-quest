const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.env.OPPORTUNITIES_UI_SOURCE || path.join(__dirname, '../public/opportunities.jsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const context = { window: {}, URL };
vm.runInNewContext(source.slice(0, source.indexOf('window.Opportunities =')), context);
const plain = value => JSON.parse(JSON.stringify(value));

test('Copy reply copies the current edited text and never changes sent or booking state', async () => {
  const item = { id: 'outreach', draftReply: 'Prepared reply', status: 'ready_for_review', schedulingUrl: 'https://example.com/calendar' };
  const original = { ...item };
  const writes = [];
  const clipboard = { async writeText(value) { writes.push(value); } };
  const edited = 'Thanks!\nI’d love to chat.';
  assert.equal(await context.window.copyJobQuestDraft(item, { outreach: edited }, clipboard), edited);
  assert.equal(await context.window.copyJobQuestDraft(item, {}, clipboard), item.draftReply);
  assert.deepEqual(writes, [edited, item.draftReply]);
  assert.deepEqual(item, original);
  await assert.rejects(context.window.copyJobQuestDraft(item, { outreach: '' }, clipboard), /Write a reply/);
  await assert.rejects(context.window.copyJobQuestDraft(item, { outreach: '  ' }, clipboard), /Write a reply/);
  assert.equal(writes.length, 2, 'an erased draft must not silently copy the older prepared reply');
  await assert.rejects(context.window.copyJobQuestDraft(item, {}, { async writeText() { throw Error('Clipboard denied'); } }), /Clipboard denied/);
});

test('saving adopts the saved baseline while retaining newer edits and cross-device conflicts', async () => {
  const oldItem = { id: 'outreach', revision: 'old-revision', draftReply: 'Old reply' };
  let drafts = { outreach: 'My edited reply' };
  const serverDrafts = { current: { outreach: oldItem.draftReply } };
  let finish;
  const savedResponse = new Promise(resolve => { finish = resolve; });
  let busy, error = '';
  const patch = source.match(/  const mutate = async \(item, action, extra = \{\}\) => \{[\s\S]*?\n  \};/)[0];
  const fresh = { id: 'outreach', revision: 'new-revision', draftReply: 'My edited reply' };
  const mutate = new Function('window', 'drafts', 'serverDrafts', 'setDrafts', 'setBusy', 'setError', 'fetch', 'load', `${patch}\nreturn mutate;`)(
    context.window, drafts, serverDrafts,
    update => { drafts = update(drafts); }, value => { busy = value; }, value => { error = value; },
    async (_url, input) => {
      assert.equal(JSON.parse(input.body).draftReply, 'My edited reply');
      return savedResponse;
    },
    async () => { drafts = context.window.mergeJobQuestDrafts(drafts, serverDrafts.current, [fresh]); serverDrafts.current = { outreach: fresh.draftReply }; },
  );
  const pending = mutate(oldItem, 'draft', { draftReply: 'My edited reply' });
  drafts = { outreach: 'Another edit while saving' };
  finish({ ok: true, async json() { return { item: fresh }; } });
  await pending;
  assert.equal(drafts.outreach, 'Another edit while saving');
  assert.equal(serverDrafts.current.outreach, 'My edited reply');
  assert.equal(busy, null);
  assert.equal(error, '');
  const reconciled = context.window.reconcileJobQuestSavedDraft({ outreach: 'My edited reply' }, 'outreach', 'My edited reply', fresh.draftReply);
  const afterOtherDevice = context.window.mergeJobQuestDrafts(reconciled, serverDrafts.current, [{ ...fresh, draftReply: 'Updated on phone' }]);
  assert.deepEqual(plain(afterOtherDevice), { outreach: 'Updated on phone' });
  const conflict = context.window.mergeJobQuestDrafts(drafts, serverDrafts.current, [{ ...fresh, draftReply: 'Updated on phone' }]);
  assert.equal(conflict.outreach, 'Another edit while saving');
});

test('due snoozes and reconnects return for review while explicit holds and missing timing stay paused', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const rows = [
    { id: 'due-snooze', kind: 'recruiter', status: 'snoozed', nextReminderAt: '2026-10-08T12:00:00Z' },
    { id: 'due-reconnect', kind: 'recruiter', status: 'reconnect_scheduled', nextReminderAt: '2026-10-09T12:00:00Z' },
    { id: 'future-snooze', kind: 'recruiter', status: 'snoozed', nextReminderAt: '2026-10-10T12:00:00Z' },
    { id: 'held', kind: 'recruiter', status: 'hold_user', nextReminderAt: '2026-10-01T12:00:00Z' },
    { id: 'unknown-reconnect', kind: 'recruiter', status: 'reconnect_scheduled' },
  ];
  assert.deepEqual(plain(context.window.filterJobQuestCards(rows, 'outreach', true, now).map(item => item.id)), ['due-snooze', 'due-reconnect']);
  assert.deepEqual(plain(context.window.filterJobQuestCards(rows, 'held', false, now).map(item => item.id)), ['future-snooze', 'held', 'unknown-reconnect']);
  assert.equal(rows[0].status, 'snoozed', 'showing a due item does not erase its saved state');
});

test('the actual report-sent handler passes the user choice and optional actual send time, never an inferred channel', () => {
  const handlerSource = source.match(/  const reportSent = item => \{[\s\S]*?\n  \};/)[0];
  const item = { id: 'reply', recommendedReplyChannel: 'linkedin' };
  for (const scenario of ['missing-channel', 'chosen', 'earlier', 'future']) {
    const mutations = [], errors = [];
    const report = new Function('sentChannels', 'sentTimes', 'setError', 'mutate', `${handlerSource}\nreturn reportSent;`)(
      scenario === 'missing-channel' ? {} : { reply: 'email' },
      scenario === 'earlier' ? { reply: '2020-01-02T12:30' } : scenario === 'future' ? { reply: '2090-01-02T12:30' } : {},
      error => errors.push(error), (target, action, body) => mutations.push({ target, action, body }),
    );
    report(item);
    if (['missing-channel', 'future'].includes(scenario)) { assert.equal(mutations.length, 0); assert.equal(errors.length, 1); }
    else {
      assert.equal(mutations[0].action, 'sent');
      assert.equal(mutations[0].body.sentChannel, 'email');
      assert.equal(mutations[0].body.sentAt, scenario === 'earlier' ? new Date('2020-01-02T12:30').toISOString() : undefined);
      assert.equal(errors.length, 0);
    }
  }
});

test('primary sources show both channels once, prefer direct reply links, and put the recommendation first', () => {
  const item = { recommendedReplyUrl: 'https://linkedin.com/message', replySources: [
    { channel: 'email', url: 'https://mail.example.com/notification', canReply: false },
    { channel: 'email', url: 'https://mail.example.com/direct', canReply: true },
    { channel: 'linkedin', url: 'https://linkedin.com/message', canReply: true },
    { channel: 'email', url: 'https://mail.example.com/followup', canReply: true },
  ] };
  assert.deepEqual(plain(context.window.jobQuestPrimaryReplySources(item).map(source => source.url)), ['https://linkedin.com/message', 'https://mail.example.com/direct']);
  assert.equal(item.replySources.length, 4, 'other source links remain available for the details section');
});

test('outreach links to a supported native role by listing or exact company and role, never company alone', () => {
  const backend = { company: 'Example', role: 'Senior Backend Engineer', url: 'https://jobs.example.com/42' };
  const frontend = { company: 'Example', role: 'Senior Frontend Engineer', url: 'https://jobs.example.com/43' };
  const roles = [backend, frontend];
  assert.equal(context.window.matchJobQuestOutreachRole({ company: 'Example', title: 'Recruiter outreach', relatedRoleUrl: 'https://jobs.example.com/42?utm_source=linkedin' }, roles), backend);
  assert.equal(context.window.matchJobQuestOutreachRole({ company: ' example ', title: ' senior   backend engineer ' }, roles), backend);
  assert.equal(context.window.matchJobQuestOutreachRole({ company: 'Example', title: 'Recruiter outreach' }, roles), null);
  assert.equal(context.window.matchJobQuestOutreachRole({ company: 'Example' }, roles), null);
  assert.equal(context.window.matchJobQuestOutreachRole({ company: 'Example', title: 'Senior Backend Engineer' }, [backend, { ...backend, url: 'https://jobs.example.com/44' }]), null, 'ambiguous exact matches stay unresolved');
  assert.equal(context.window.matchJobQuestOutreachRole({ relatedRoleUrl: 'javascript:alert(1)' }, roles), null);
});


test('setup request waits for the visible loaded Outreach form, then opens and focuses it once per request', () => {
  const effect = source.match(/  useEffect\(\(\) => \{\n    if \(!active \|\| !data \|\| !configureRequest[\s\S]*?\n  \}, \[active, data, configureRequest\]\);/)[0];
  const run = new Function('window', 'active', 'data', 'configureRequest', 'configuredRequest', 'setAccountsOpen', 'accountPanel', 'accountInput', 'useEffect', effect);
  const calls = [], panel = { open: false }, input = {
    scrollIntoView(options) { calls.push(['scroll', options.block]); },
    focus(options) { calls.push(['focus', options.preventScroll]); },
  };
  const applied = { current: 0 }, panelRef = { current: panel }, inputRef = { current: input };
  const invoke = (active, data, request) => run(context.window, active, data, request, applied,
    open => calls.push(['open', open]), panelRef, inputRef, callback => callback());
  invoke(true, null, 1);
  invoke(false, {}, 1);
  assert.equal(applied.current, 0);
  assert.deepEqual(calls, []);
  invoke(true, {}, 1);
  assert.equal(panel.open, true);
  assert.deepEqual(calls, [['open', true], ['scroll', 'center'], ['focus', true]]);
  invoke(true, { refreshed: true }, 1);
  assert.equal(calls.length, 3, 'refresh must not steal focus from account editing');
  invoke(true, {}, 2);
  assert.equal(calls.length, 6, 'returning through Setup should reopen the form');
});

test('access-check action copies an actionable request without account writes, scans or sending', async () => {
  const handler = source.match(/  const copyAccessRequest = async \(accounts = data.accounts\) => \{[\s\S]*?\n  \};/)[0];
  const writes = [], statuses = [], errors = [];
  const copy = new Function('window', 'navigator', 'data', 'setAccessRequestCopied', 'setError', `${handler}\nreturn copyAccessRequest;`)(
    context.window, { clipboard: { async writeText(text) { writes.push(text); } } }, { accounts: [{ id: 'gmail', kind: 'gmail', label: 'you@example.test' }] },
    value => statuses.push(value), value => errors.push(value));
  await copy();
  assert.equal(writes.length, 1);
  assert.match(writes[0], /already authorized inbox tools or browser access/);
  assert.match(writes[0], /Do not send messages/);
  assert.deepEqual(statuses, [writes[0]]);
  assert.deepEqual(errors, []);
  const denied = new Function('window', 'navigator', 'data', 'setAccessRequestCopied', 'setError', `${handler}\nreturn copyAccessRequest;`)(
    context.window, { clipboard: { async writeText() { throw Error('denied'); } } }, { accounts: [] },
    value => statuses.push(value), value => errors.push(value));
  await denied();
  assert.match(errors[0], /copy it manually/);
  assert.equal(statuses.length, 1);
});


test('account access requests target the selected identity and preserve evidence and revision safeguards', () => {
  const account = { id: 'li', kind: 'linkedin', label: 'Profile name', accessStatus: 'unverified' };
  const request = context.window.jobQuestOutreachAccessRequest([account]);
  assert.match(request, /\"id\":\"li\"/);
  assert.match(request, /\"label\":\"Profile name\"/);
  assert.match(request, /signed-in profile/);
  assert.match(request, /direct messages and LinkedIn Jobs separately/);
  assert.match(request, /accountsRevision as revision/);
  assert.match(request, /preserving all other saved accounts and fields/);
  assert.match(request, /actual successful read/);
  assert.match(request, /Do not send messages, apply for jobs, or change schedules/);
  assert.equal(account.accessStatus, 'unverified');
  const other = { id: 'other', kind: 'gmail', label: 'other@example.test' };
  assert.doesNotMatch(request, /other@example/);
  assert.match(context.window.jobQuestOutreachAccessRequest([account, other]), /other@example/);
});

test('setup offers distinct LinkedIn browser surfaces and a Gmail account chooser', () => {
  const linkedin = plain(context.window.jobQuestAccountSetupLinks('linkedin'));
  assert.deepEqual(linkedin.map(link => new URL(link.url).pathname), ['/login', '/messaging/', '/jobs/']);
  for (const link of linkedin) assert.equal(new URL(link.url).origin, 'https://www.linkedin.com');
  const gmail = context.window.jobQuestAccountSetupLinks('gmail');
  assert.equal(new URL(gmail[0].url).hostname, 'accounts.google.com');
  assert.equal(new URL(gmail[0].url).searchParams.get('continue'), 'https://mail.google.com/mail/');
  assert.deepEqual(plain(context.window.jobQuestAccountSetupLinks('linkedin_email')), plain(gmail));
});

test('external review ownership never presents native Intel as its inbox collector', () => {
  const summary = context.window.jobQuestCollectionSummary({outreachOwner:'external',schedule:{installed:true},schedulePreference:{frequency:'daily',time:'09:00'}});
  assert.match(summary, /separate career review/);
  assert.match(summary, /native Intel does not refresh these accounts/);
  assert.doesNotMatch(summary, /09:00/);
});

test('collection summary distinguishes off, unreadable, saved timing and unknown timing', () => {
  const summary = context.window.jobQuestCollectionSummary;
  assert.match(summary({outreachOwner:'native',schedule:{installed:false}}), /runs are off/);
  assert.match(summary({outreachOwner:'native',schedule:{installed:false,error:'failed'}}), /could not be checked/);
  assert.match(summary({outreachOwner:'native',schedule:{installed:true,cron:'30 8 * * 1-5'},schedulePreference:{frequency:'weekdays',time:'08:30',cron:'30 8 * * 1-5'},timeZone:'America/New_York'}), /on weekdays at 08:30 \(America\/New_York\)/);
  assert.match(summary({outreachOwner:'native',schedule:{installed:true}}), /see its timing/);
});

test('account review labels preserve partial and unavailable coverage instead of claiming connected', () => {
  const label = context.window.jobQuestAccountReviewStatus;
  assert.equal(label(null), 'No review recorded');
  assert.equal(label({status:'partial'}), 'Partial review');
  assert.equal(label({status:'blocked'}), 'Could not review');
  assert.equal(label({status:'ready'}), 'Reviewed');
  assert.equal(label({status:'unexpected'}), 'See review details');
});

test('stale schedule preferences do not override the installed cron', () => {
  const summary=context.window.jobQuestCollectionSummary({outreachOwner:'native',schedule:{installed:true,cron:'0 9 * * *'},schedulePreference:{frequency:'daily',time:'07:00',cron:'0 7 * * *'}});
  assert.doesNotMatch(summary,/07:00/);
  assert.match(summary,/see its timing/);
});
