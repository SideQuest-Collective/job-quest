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

test('mailbox groups combine legacy notification aliases, prefer Gmail and preserve original saved records', () => {
  const accounts = [
    {id:'notification',kind:'linkedin_email',label:' You@Example.test ',sourceName:'legacy'},
    {id:'li',kind:'linkedin',label:'You@Example.test'},
    {id:'gmail',kind:'gmail',label:'you@example.test',sourceName:'gmail'},
    {id:'other',kind:'gmail',label:'other@example.test'},
    {id:'legacy-only',kind:'linkedin_email',label:'legacy@example.test'},
  ];
  const original = JSON.stringify(accounts);
  const groups = plain(context.window.jobQuestAccountGroups(accounts));
  assert.equal(groups.length,4);
  assert.deepEqual(groups[0], {...accounts[2],accountIds:['notification','gmail']});
  assert.deepEqual(groups[1], {...accounts[1],accountIds:['li']});
  assert.deepEqual(groups[3].accountIds,['legacy-only']);
  assert.equal(JSON.stringify(accounts),original,'grouping does not rewrite legacy data or source mappings');
  assert.doesNotMatch(source, /<option value="linkedin_email">/);
  assert.match(source, /Recruiter emails, including LinkedIn notifications received here/);
  assert.match(source, /data.accounts.filter\(a=>!account.accountIds.includes\(a.id\)\)/);
});

test('adding Gmail refuses an already saved notification mailbox regardless of case', () => {
  const handler=source.match(/  const addAccount = event => \{[\s\S]*?\n  \};/)[0];
  const errors=[], saves=[];
  const add=new Function('accountLabel','data','accountKind','setError','saveAccounts',`${handler}\nreturn addAccount;`)(
    ' YOU@example.test ',{accounts:[{id:'old',kind:'linkedin_email',label:'you@EXAMPLE.test'}]},'gmail',value=>errors.push(value),value=>saves.push(value));
  add({preventDefault(){}});
  assert.deepEqual(saves,[]);
  assert.deepEqual(errors,['This account is already selected.']);
});

test('access checks send only selected ids and the saved revision to the background API', async () => {
  const calls = [];
  const check = { id: 'check-1', status: 'running', accountIds: ['gmail'] };
  const fetcher = async (url, request) => { calls.push({url, request}); return {ok:true,json:async()=>({check})}; };
  assert.equal(await context.window.requestJobQuestAccessCheck(fetcher, ['gmail'], 'revision-1'), check);
  assert.equal(calls[0].url, '/api/opportunities/access-check');
  assert.equal(calls[0].request.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].request.body), {accountIds:['gmail'],revision:'revision-1'});
  await assert.rejects(context.window.requestJobQuestAccessCheck(async()=>({ok:false,json:async()=>({error:'Refresh accounts first.'})}), ['gmail'], 'old'), /Refresh accounts first/);
  await assert.rejects(context.window.requestJobQuestAccessCheck(async()=>({ok:true,json:async()=>({})}), ['gmail'], 'old'), /returned no status/);
  assert.doesNotMatch(source, /copyAccessRequest|jobQuestOutreachAccessRequest|paste.*agent chat|Copy request/);
  assert.match(source, /does not save outreach or send anything/);
});

test('latest results distinguish active verification, blockers, failed and interrupted checks from saved history', () => {
  const result = context.window.jobQuestAccessResult;
  assert.equal(result(null, 'gmail'), null);
  assert.equal(result({accountIds:['other'],status:'running'}, 'gmail'), null);
  const check = {accountIds:['gmail'],status:'running'};
  assert.equal(result(check, 'gmail').label, 'Checking…');
  for (const status of ['sign_in_required','connection_unavailable','identity_mismatch','unverified']) {
    const current = result({...check,status:'completed',results:[{accountId:'gmail',status,detail:'Actual evidence'}]}, 'gmail');
    assert.notEqual(current.label, 'Access verified');
    assert.equal(current.detail, 'Actual evidence');
    assert.match(current.action, /again/);
  }
  const verified = result({...check,status:'completed',results:[{accountId:'gmail',status:'verified',detail:'Identity confirmed'}]}, 'gmail');
  assert.equal(verified.label, 'Access verified');
  assert.equal(verified.action, undefined);
  for (const status of ['failed','interrupted']) {
    const current = result({...check,status,error:'Agent unavailable',results:[{accountId:'gmail',status:'verified'}]}, 'gmail');
    assert.notEqual(current.label, 'Access verified');
    assert.equal(current.detail, 'Agent unavailable');
  }
  assert.notEqual(result({...check,status:'completed',results:[]}, 'gmail').label, 'Access verified');
  assert.match(source, /<dt>Saved access history<\/dt>/);
});

test('the actual check handler prevents duplicate starts, uses the current revision and retains start errors', async () => {
  const handler = source.match(/  const checkAccess = async \(accounts = data.accounts\) => \{[\s\S]*?\n  \};/)[0];
  const run = (locked, request) => {
    const calls = [], checks = [], errors = [], starting = [], accessSequence = {current:0};
    const invoke = new Function('window','fetch','data','accountsLocked','accessSequence','setAccessStarting','setAccessError','setAccessCheck','load','refreshAccessCheck', `${handler}\nreturn checkAccess;`)(
      {requestJobQuestAccessCheck:request},()=>{}, {accounts:[{id:'gmail'},{id:'linkedin'}],accountsRevision:'fresh'},locked,accessSequence,
      value=>starting.push(value), value=>errors.push(value), value=>checks.push(value),async()=>calls.push('load'),async()=>{calls.push('refresh');errors.push('');});
    return {invoke,calls,checks,errors,starting,accessSequence};
  };
  let requests = 0;
  const expectedIds = [];
  const request = async (_fetch, ids, revision) => {requests++;assert.deepEqual(ids,expectedIds.shift());assert.equal(revision,'fresh');return{id:'1',status:'running'};};
  const locked = run(true,request);
  await locked.invoke([{id:'gmail'}]);
  assert.equal(requests,0);
  const ready = run(false,request);
  expectedIds.push(['gmail']);
  await ready.invoke([{id:'gmail'}]);
  assert.equal(requests,1);
  assert.deepEqual(ready.starting,[true,false]);
  assert.equal(ready.checks[0].status,'running');
  assert.deepEqual(ready.calls,[],'a running check does not claim account history has been saved');
  expectedIds.push(['gmail','old-notifications']);
  await ready.invoke([{id:'gmail',accountIds:['gmail','old-notifications']}]);
  expectedIds.push(['gmail','linkedin']);
  await ready.invoke();
  const failed=run(false,async()=>{throw Error('Agent unavailable');});
  await failed.invoke();
  assert.deepEqual(failed.calls,['refresh']);
  assert.equal(failed.errors.at(-1),'Agent unavailable');
});

test('access polling runs every three seconds only while active and running, and stops on navigation', () => {
  const effect = source.match(/  useEffect\(\(\) => \{\n    if \(!active \|\| !configureOnly \|\| !accessRunning\)[\s\S]*?\n  \}, \[active, configureOnly, accessRunning\]\);/)[0];
  const run = new Function('active','configureOnly','accessRunning','refreshAccessCheck','setInterval','clearInterval','useEffect',effect);
  for (const state of [[false,true,true],[true,false,true],[true,true,false]]) {
    run(...state,()=>assert.fail('must not refresh'),()=>assert.fail('must not poll'),()=>{},callback=>callback());
  }
  let callback, cleanup, current, clears=0;
  run(true,true,true, predicate=>{current=predicate();}, (fn,delay)=>{callback=fn;assert.equal(delay,3000);return 17;}, id=>{assert.equal(id,17);clears++;}, effect=>{cleanup=effect();});
  callback();assert.equal(current,true);
  cleanup();assert.equal(clears,1);
  callback();assert.equal(current,false,'in-flight responses are ignored after navigation');
});

test('access status reload ignores stale responses and refreshes saved accounts after completion', async () => {
  const handler = source.match(/  const refreshAccessCheck = async \(isCurrent = \(\) => true\) => \{[\s\S]*?\n  \};/)[0];
  const calls=[], checks=[], errors=[], loading=[], sequence={current:0}, finished={current:''};
  const completed={id:'check',status:'completed',saved:true};
  const reload=new Function('fetch','accessSequence','setAccessCheck','setAccessError','accessFinished','load','setAccessLoading',`${handler}\nreturn refreshAccessCheck;`)(
    async()=>({ok:true,json:async()=>({check:completed})}),sequence,value=>checks.push(value),value=>errors.push(value),finished,async options=>calls.push(options),value=>loading.push(value));
  await reload(()=>false);
  assert.equal(checks.length,0);
  await reload();await reload();
  assert.equal(checks.length,2);
  assert.equal(calls.length,1,'each finished result refreshes account history once');
  assert.deepEqual(calls[0],{clearError:false});
  assert.deepEqual(loading,[false,false]);
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
