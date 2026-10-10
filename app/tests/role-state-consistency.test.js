const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const state = require(process.env.JOBQUEST_ROLE_STATE_SOURCE || '../lib/jobs/role-state');
const tracker = require(process.env.JOBQUEST_TRACKER_SOURCE || '../lib/interview/tracker-effects');
const serverSource = fs.readFileSync(process.env.JOBQUEST_SERVER_SOURCE || path.join(__dirname, '../server.js'), 'utf8');
const html = fs.readFileSync(process.env.JOBQUEST_HTML_SOURCE || path.join(__dirname, '../public/index.html'), 'utf8');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobquest-role-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = {}, events = [];
  vm.runInNewContext(serverSource.slice(serverSource.indexOf('// Role actions (save/skip/apply'), serverSource.indexOf('// --- Evaluate Practice Answer ---')), {
    app: Object.fromEntries(['get','post'].map(method => [method, (route, fn) => { handlers[`${method} ${route}`] = fn; }])),
    fs, path, DATA_DIR: root, ...state, ...tracker, logActivity() {}, roleEvents: { emit(...args) { events.push(args); } },
  });
  const call = (method, route, body) => {
    let status = 200, value;
    handlers[`${method} ${route}`]({ body }, { status(next) { status = next; return this; }, json(next) { value = JSON.parse(JSON.stringify(next)); return this; } });
    return { status, body: value };
  };
  return { root, call, events };
}
test('Discover application confirmation advances tracked researching status and side effects run once across both routes', t => {
  const f = fixture(t), key = 'Example|Senior Backend Engineer';
  fs.writeFileSync(path.join(f.root, 'role-actions.json'), JSON.stringify({ saved: ['Other|SWE'], skipped: ['Skipped|SWE'], applied: [], custom: 'preserved' }));
  fs.writeFileSync(path.join(f.root, 'role-tracker.json'), JSON.stringify({ [key]: { stage: 'researching', notes: 'My notes', checklist: [{ text: 'Keep', done: false }], timeline: [] } }));
  const input = { saved: ['Other|SWE'], skipped: ['Skipped|SWE'], applied: [key] };
  assert.equal(f.call('post', '/api/role-actions', input).status, 200);
  const tracked = f.call('get', '/api/role-tracker').body;
  assert.equal(tracked[key].stage, 'applied');
  assert.equal(tracked[key].notes, 'My notes');
  assert.equal(tracked[key].applicationSubmitted, true);
  assert.equal(f.call('get', '/api/role-actions').body.custom, 'preserved');
  f.call('post', '/api/role-actions', input);
  f.call('post', '/api/role-tracker', tracked);
  assert.deepEqual(f.events, [['applied', key]]);
  assert.equal(f.call('get', '/api/role-tracker').body[key].timeline.length, 1);
});
test('Intel application confirmation appears in native actions and later interview stages retain application history and other decisions', t => {
  const f = fixture(t), key = 'Example|Backend', other = 'Example|Frontend';
  fs.writeFileSync(path.join(f.root, 'role-actions.json'), JSON.stringify({ saved: [other], skipped: ['Skipped|SWE'], applied: [] }));
  const entry = { stage: 'applied', applicationSubmitted: true, notes: 'Keep', timeline: [] };
  assert.equal(f.call('post', '/api/role-tracker', { [key]: entry }).status, 200);
  for (const stage of ['phone-screen', 'onsite', 'rejected']) assert.equal(f.call('post', '/api/role-tracker', { [key]: { ...entry, stage } }).status, 200);
  assert.deepEqual(f.call('get', '/api/role-actions').body, { saved: [other], skipped: ['Skipped|SWE'], applied: [key] });
  assert.deepEqual(f.events, [['applied', key]]);
  const stale = f.call('post', '/api/role-actions', { saved: [other], skipped: ['Skipped|SWE'], applied: [] });
  assert.equal(stale.status, 200);
  assert.deepEqual(f.call('get', '/api/role-actions').body.applied, [key]);
});
test('reply state and a sourced phone screen do not fabricate application submission', t => {
  const f = fixture(t);
  f.call('post', '/api/role-tracker', { 'Example|Recruiter': { status: 'awaiting_recruiter', sentAt: '2026-10-09T12:00:00Z' }, 'Example|Sourced interview': { stage: 'phone-screen' } });
  assert.deepEqual(f.call('get', '/api/role-actions').body.applied, []);
  assert.deepEqual(f.events, []);
});
test('invalid role actions preserve both stores and failed second-file publication rolls back both original files', t => {
  const f = fixture(t), actionsFile = path.join(f.root, 'role-actions.json'), trackerFile = path.join(f.root, 'role-tracker.json');
  fs.writeFileSync(actionsFile, JSON.stringify({ saved: [], skipped: [], applied: [] })); fs.writeFileSync(trackerFile, '{}');
  const before = [fs.readFileSync(actionsFile, 'utf8'), fs.readFileSync(trackerFile, 'utf8')];
  for (const body of [null, {}, { saved: [], skipped: [], applied: [42] }]) assert.equal(f.call('post', '/api/role-actions', body).status, 400);
  const rename = fs.renameSync; let fail = true;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === actionsFile && fail) { fail = false; throw Error('Disk interruption'); } rename(from, to); });
  assert.equal(f.call('post', '/api/role-actions', { saved: [], skipped: [], applied: ['Example|Backend'] }).status, 500);
  assert.deepEqual([fs.readFileSync(actionsFile, 'utf8'), fs.readFileSync(trackerFile, 'utf8')], before);
  assert.deepEqual(f.events, []);
});
test('Discover and Intel use shared native status without inferring an application from a reply or interview alone', () => {
  const fn = new Function(`${html.match(/function nativeRoleStatus\([\s\S]*?\n\}/)[0]}\nreturn nativeRoleStatus;`)();
  const key = 'Example|Backend';
  assert.deepEqual(fn(key, { applied: [key] }, { [key]: { stage: 'researching' } }), { applied: true, stage: 'applied', pipelineStarted: true });
  assert.deepEqual(fn(key, { applied: [] }, { [key]: { stage: 'onsite', applicationSubmitted: true } }), { applied: true, stage: 'onsite', pipelineStarted: true });
  assert.deepEqual(fn(key, { applied: [] }, { [key]: { stage: 'phone-screen' } }), { applied: false, stage: 'phone-screen', pipelineStarted: true });
  assert.deepEqual(fn(key, { applied: [] }, { [key]: { status: 'awaiting_recruiter' } }), { applied: false, stage: 'discovered', pipelineStarted: false });
});
test('actual Discover confirmation waits for durable save and leaves the dialog open with a retryable error on failure', async () => {
  const start = html.indexOf('function Discover(');
  const discover = html.slice(start, html.indexOf('/* ===== APPLY MODAL ===== */', start));
  const handler = discover.match(/  const confirmApply = async \(\) => \{[\s\S]*?\n  \};/)[0];
  for (const failed of [false, true]) {
    let busy = false, error = '', actions, closed = false, finish;
    const request = new Promise((resolve, reject) => { finish = failed ? reject : resolve; });
    const confirm = new Function('actionBusy','applyRole','roleActions','setActionBusy','setActionError','api','setRoleActions','setApplyRole', `${handler}\nreturn confirmApply;`)(false, { company: 'Example', role: 'Backend' }, { saved: ['Example|Backend'], skipped: ['Other|SWE'], applied: [] }, value => { busy = value; }, value => { error = value; }, { post() { return request; } }, value => { actions = value; }, value => { closed = value === null; });
    const pending = confirm(); assert.equal(busy, true); assert.equal(actions, undefined); assert.equal(closed, false);
    finish(failed ? Error('Offline') : { success: true }); await pending;
    assert.equal(busy, false);
    assert.equal(closed, !failed);
    if (failed) { assert.equal(error, 'Offline'); assert.equal(actions, undefined); }
    else assert.deepEqual(actions, { saved: [], skipped: ['Other|SWE'], applied: ['Example|Backend'] });
  }
});

test('Intel retains failed edits, retries explicitly and serializes overlapping saves', async () => {
  const start = html.indexOf('  const saveTracker =', html.indexOf('function Intel('));
  const code = html.slice(start, html.indexOf('  // Ensure tracker entry exists', start));
  const calls = [], scheduled = [], updates = [], errors = [], saving = [];
  const context = { trackerRevision: {current:0}, saveTimer: {current:null}, pendingTrackerRef: {current:null}, roleTrackerPendingRef: {current:false}, trackerSaveQueue:{current:Promise.resolve()},
    setRoleTracker:v=>updates.push(v), setTrackerError:v=>errors.push(v), setTrackerSaving:v=>saving.push(v), clearTimeout(){},
    setTimeout:fn=>{scheduled.push(fn);return scheduled.length;},
    api:{post:(_url,body)=>new Promise((resolve,reject)=>calls.push({body,resolve,reject}))} };
  vm.runInNewContext(code+';this.saveTracker = saveTracker;',context);
  const a={A:{notes:'Keep unsaved'}};
  context.saveTracker(a);
  const first=scheduled.shift()(); await new Promise(setImmediate);
  calls[0].reject(Error('Offline')); await first;
  assert.equal(context.roleTrackerPendingRef.current,true);
  assert.equal(context.pendingTrackerRef.current,a);
  assert.equal(context.saveTimer.current,1);
  assert.equal(errors.at(-1),'Offline');
  context.saveTracker(context.pendingTrackerRef.current);
  const retry=scheduled.shift()(); await new Promise(setImmediate);
  calls[1].resolve({success:true}); await retry;
  assert.equal(context.roleTrackerPendingRef.current,false);
  assert.equal(context.pendingTrackerRef.current,null);
  const b={A:{notes:'Earlier'}},c={A:{notes:'Latest'}};
  context.saveTracker(b); const bTask=scheduled.shift()(); await new Promise(setImmediate);
  context.saveTracker(c); const cTask=scheduled.shift()(); await new Promise(setImmediate);
  assert.equal(calls.length,3,'new save waits for earlier write');
  calls[2].resolve({success:true}); await bTask; await new Promise(setImmediate);
  assert.equal(context.roleTrackerPendingRef.current,true,'older success cannot clear latest pending edits');
  assert.equal(calls[3].body,c);
  calls[3].resolve({success:true}); await cTask;
  assert.equal(context.roleTrackerPendingRef.current,false);
  assert.equal(saving.at(-1),false);
  assert.match(html,/if \(!roleTrackerPendingRef.current\) setRoleTracker\(value\)/);
  assert.match(html,/Role changes are unsaved\./);
});

test('Discover saved and applied cards launch their exact native role context', () => {
  const discover = html.slice(html.indexOf('function Discover('), html.indexOf('/* ===== APPLY MODAL ===== */', html.indexOf('function Discover(')));
  assert.equal((discover.match(/onOpenRole\(r\)/g) || []).length, 2);
  assert.match(html, /<Discover onOpenRole=\{openNativeRole\}/);
});

test('interview ingestion preserves explicit legacy applied history without inferring submission from phone-screen alone', () => {
  const legacy = {stage:'applied',notes:'Preserved'};
  assert.deepEqual(tracker.applyStage(legacy, 'recruiter', false), {from:'applied',to:'phone-screen'});
  assert.equal(legacy.applicationSubmitted,true);
  assert.deepEqual(state.applicationKeys({saved:[],skipped:[],applied:[]},{'Exact Co|Exact role':legacy}), ['Exact Co|Exact role']);
  const screen = {stage:'phone-screen'};
  tracker.applyStage(screen, 'coding', false);
  assert.equal(screen.applicationSubmitted,undefined);
  assert.deepEqual(state.applicationKeys({applied:[]},{'Exact Co|Other role':screen}), []);
});


test('Intel first-mount effects honor a valid role launch instead of the first list row', () => {
  const start = html.indexOf('  // A source-linked recruiter card opens', html.indexOf('function Intel('));
  const code = html.slice(start, html.indexOf('  const selected =', start));
  const first = 'First Company|Backend Engineer', requested = 'Requested Company|Platform Engineer';
  function mount(launchRole, selectedKey = null) {
    const effects = [], selections = [], filters = [];
    vm.runInNewContext(code, {
      launchRole, selectedKey, roleMap:{[first]:{},[requested]:{}}, allRoles:[{},{}], filtered:[{key:first},{key:requested}],
      setSelectedKey:value=>selections.push(value), setFilter:value=>filters.push(value),
      useEffect:fn=>effects.push(fn),
    });
    // React runs both mount effects from the same render where selectedKey is null.
    for (const effect of effects) effect();
    return {key:selections.at(-1),filters};
  }
  assert.equal(mount({key:requested,request:1}).key,requested);
  assert.deepEqual(mount({key:requested,request:1}).filters,['all']);
  assert.equal(mount(null).key,first);
  assert.equal(mount({key:'Missing|Role',request:2}).key,first);
  assert.equal(mount({key:requested,request:3},first).key,requested);
});
