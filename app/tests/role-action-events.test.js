const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withServer, post } = require('./helpers/server');

const UUID = '0b6c1f9e-1111-2222-3333-444455556666';
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function dataDir(t, { actions = { saved: [], skipped: [], applied: [] }, tracker = {}, archived, intel = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-role-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'intel'));
  fs.writeFileSync(path.join(dir, 'role-actions.json'), JSON.stringify(actions));
  fs.writeFileSync(path.join(dir, 'role-tracker.json'), JSON.stringify(tracker));
  if (archived) fs.writeFileSync(path.join(dir, 'role-actions-archived-2026-11-05.json'), JSON.stringify(archived));
  fs.writeFileSync(path.join(dir, 'intel', '2026-11-05.json'), JSON.stringify({ date: '2026-11-05', roles: intel }));
  return dir;
}
const event = (base, body) => fetch(`${base}/api/role-actions/event`, post(body)).then(async res => { const text = await res.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; } return { status: res.status, body: parsed }; });
const history = base => fetch(`${base}/api/role-history`).then(res => res.json());

test('the ledger seeds from saved, skipped, applied, tracker and archived roles without rewriting those files', async t => {
  const dir = dataDir(t, {
    actions: { saved: ['Linear|Senior Product Engineer'], skipped: ['Vestwell|Senior Software Engineer, AI'], applied: ['Aaru|Software Engineer, Applied AI'], custom: 'kept' },
    tracker: { 'Hume AI|Senior Platform Engineer': { stage: 'discovered', timeline: [{ date: '2026-04-28T04:00:48.788Z', event: 'Added' }] }, 'Carta|Senior Software Engineer II, KYC': { stage: 'applied' } },
    archived: { archivedAt: '2026-11-05T15:44:10', saved: ['Anthropic|Senior Software Engineer, Claude.ai'] },
    intel: [{ company: 'Linear', role: 'Senior Product Engineer', url: `https://jobs.ashbyhq.com/linear/${UUID}/application` }],
  });
  const before = ['role-actions.json', 'role-tracker.json', 'role-actions-archived-2026-11-05.json'].map(name => fs.readFileSync(path.join(dir, name), 'utf8'));
  await withServer(dir, async base => {
    const script = await fetch(`${base}/role-identity.js`);
    assert.equal(script.status, 200, 'the browser can load the shared identity module');
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /root\.JobQuestRoleIdentity = api/);
    const seeded = await history(base);
    const byKey = Object.fromEntries(seeded.handled.map(entry => [entry.key, entry]));
    assert.equal(byKey['Linear|Senior Product Engineer'].action, 'save');
    assert.equal(byKey['Linear|Senior Product Engineer'].url, `https://jobs.ashbyhq.com/linear/${UUID}`, 'canonical URL recorded from Intel');
    assert.equal(byKey['Vestwell|Senior Software Engineer, AI'].action, 'skip');
    assert.equal(byKey['Aaru|Software Engineer, Applied AI'].action, 'apply');
    assert.equal(byKey['Hume AI|Senior Platform Engineer'].action, 'track');
    assert.equal(byKey['Hume AI|Senior Platform Engineer'].at, '2026-04-28T04:00:48.788Z');
    assert.equal(byKey['Carta|Senior Software Engineer II, KYC'].action, 'apply');
    assert.equal(byKey['Anthropic|Senior Software Engineer, Claude.ai'].action, 'save');
    assert.equal(seeded.undo, null, 'seeded history is not undoable');
    const ledger = read(dir, 'role-history.json');
    assert.ok(ledger.seededFrom.includes('role-actions-archived-2026-11-05.json'));
    assert.equal(ledger.events.length, 6);
    // A second read does not reseed.
    await history(base);
    assert.equal(read(dir, 'role-history.json').events.length, 6);
  });
  assert.deepEqual(['role-actions.json', 'role-tracker.json', 'role-actions-archived-2026-11-05.json'].map(name => fs.readFileSync(path.join(dir, name), 'utf8')), before);
});

test('roles removed from Saved through the legacy endpoint stay handled in the ledger', async t => {
  const dir = dataDir(t);
  await withServer(dir, async base => {
    await history(base);
    assert.equal((await fetch(`${base}/api/role-actions`, post({ saved: ['Acme|Senior SWE'], skipped: [], applied: [] }))).status, 200);
    assert.equal((await fetch(`${base}/api/role-actions`, post({ saved: [], skipped: [], applied: [] }))).status, 200);
    assert.deepEqual(read(dir, 'role-actions.json').saved, []);
    const handled = (await history(base)).handled;
    assert.deepEqual(handled.map(entry => [entry.key, entry.action]), [['Acme|Senior SWE', 'save']]);
    assert.equal(read(dir, 'role-history.json').events[0].source, 'role-actions');
  });
});

test('per-role events apply to current files, so stale tabs, concurrent writers and double clicks never clobber each other', async t => {
  const dir = dataDir(t, { actions: { saved: ['Existing|Saved Role'], skipped: [], applied: [], custom: { keep: true } } });
  await withServer(dir, async base => {
    // Tab A skips X, then a stale tab B (which never saw X skipped) saves Y.
    assert.equal((await event(base, { action: 'skip', key: 'Xco|Senior Engineer' })).status, 200);
    const stale = await event(base, { action: 'save', key: 'Yco|Staff Engineer', url: `https://jobs.ashbyhq.com/yco/${UUID}/application` });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body.actions.skipped, ['Xco|Senior Engineer']);
    assert.deepEqual(stale.body.actions.saved, ['Existing|Saved Role', 'Yco|Staff Engineer']);
    // Many concurrent writers plus a double-click on the same role.
    const keys = Array.from({ length: 12 }, (_, i) => `Co${i}|Engineer ${i}`);
    const results = await Promise.all([...keys.map((key, i) => event(base, { action: i % 2 ? 'save' : 'skip', key })), event(base, { action: 'skip', key: 'Xco|Senior Engineer' })]);
    assert.ok(results.every(result => result.status === 200));
    assert.equal(results.at(-1).body.duplicate, true);
    const actions = read(dir, 'role-actions.json');
    assert.deepEqual(actions.custom, { keep: true });
    for (const [i, key] of keys.entries()) assert.ok(actions[i % 2 ? 'saved' : 'skipped'].includes(key), key);
    assert.equal(actions.skipped.filter(key => key === 'Xco|Senior Engineer').length, 1);
    const ledger = read(dir, 'role-history.json');
    assert.equal(ledger.events.filter(item => item.source === 'discover').length, 14);
    assert.equal(ledger.events.find(item => item.key === 'Yco|Staff Engineer').url, `https://jobs.ashbyhq.com/yco/${UUID}`);
    // Invalid events are rejected without touching files.
    const bytes = fs.readFileSync(path.join(dir, 'role-actions.json'), 'utf8');
    for (const body of [{ action: 'delete', key: 'A|B' }, { action: 'skip' }, { action: 'skip', key: 'no-separator' }, null]) assert.equal((await event(base, body)).status, 400);
    assert.equal(fs.readFileSync(path.join(dir, 'role-actions.json'), 'utf8'), bytes);
  });
});

test('undo walks back Discover actions one at a time, also after a restart, and marks ledger events undone', async t => {
  const dir = dataDir(t);
  await withServer(dir, async base => {
    await event(base, { action: 'skip', key: 'Acme|Senior Backend Engineer', keys: ['Acme|Senior Backend Engineer', 'Acme|Sr. Backend Engineer'] });
    await event(base, { action: 'save', key: 'Beta|Staff Engineer' });
    const state = await history(base);
    assert.equal(state.undo.key, 'Beta|Staff Engineer');
    assert.equal(state.undo.action, 'save');
  });
  // Reload: a fresh server process reads the ledger.
  await withServer(dir, async base => {
    const target = (await history(base)).undo;
    assert.equal((await event(base, { action: 'undo', eventId: target.id, key: 'Wrong|Role' })).status, 409, 'a stale undo target is refused');
    const first = await event(base, { action: 'undo', eventId: target.id, key: target.key });
    assert.equal(first.status, 200);
    assert.equal(first.body.undone.key, 'Beta|Staff Engineer');
    assert.deepEqual(first.body.actions.saved, []);
    assert.deepEqual(first.body.actions.skipped, ['Acme|Senior Backend Engineer']);
    assert.equal(first.body.history.handled.some(entry => entry.key === 'Beta|Staff Engineer'), false, 'undone save no longer counts as handled');
    assert.equal(first.body.history.undo.key, 'Acme|Senior Backend Engineer');
    const second = await event(base, { action: 'undo' });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.actions.skipped, []);
    assert.deepEqual(second.body.history.handled, []);
    assert.equal(second.body.history.undo, null);
    assert.equal((await event(base, { action: 'undo' })).status, 409);
    const ledger = read(dir, 'role-history.json');
    assert.equal(ledger.events.filter(item => item.undoneAt).length, 2, 'history is kept, marked undone');
    assert.equal(ledger.events.filter(item => item.action === 'undo').length, 2);
  });
});

test('undoing an application restores the exact tracker entry, and refuses once the application moved on', async t => {
  const key = 'Acme|Senior SWE';
  const entry = { stage: 'researching', notes: 'My notes', checklist: [{ text: 'Keep', done: false }], timeline: [{ date: '2026-10-01', event: 'Added' }] };
  const dir = dataDir(t, { actions: { saved: [key], skipped: [], applied: [] }, tracker: { [key]: entry, 'Other|Role': { stage: 'onsite' } } });
  await withServer(dir, async base => {
    const applied = await event(base, { action: 'apply', key });
    assert.equal(applied.status, 200);
    assert.equal(read(dir, 'role-tracker.json')[key].stage, 'applied');
    assert.deepEqual(applied.body.actions.saved, []);
    assert.equal((await history(base)).undo.action, 'apply');
    const undone = await event(base, { action: 'undo' });
    assert.equal(undone.status, 200);
    assert.deepEqual(read(dir, 'role-tracker.json'), { [key]: entry, 'Other|Role': { stage: 'onsite' } });
    assert.deepEqual(read(dir, 'role-actions.json').saved, [key]);
    assert.deepEqual(read(dir, 'role-actions.json').applied, []);
    // Apply again, then advance the application in Intel: undo must not erase that.
    await event(base, { action: 'apply', key });
    const tracker = read(dir, 'role-tracker.json');
    await fetch(`${base}/api/role-tracker`, post({ ...tracker, [key]: { ...tracker[key], stage: 'phone-screen' } }));
    const refused = await event(base, { action: 'undo' });
    assert.equal(refused.status, 409);
    assert.equal(read(dir, 'role-tracker.json')[key].stage, 'phone-screen');
  });
});

test('apply and undo responses carry only the changed tracker entry, so a later full-tracker save cannot restore an undone application', async t => {
  const key = 'Acme|Senior SWE';
  const other = { stage: 'onsite', notes: 'keep me' };
  const dir = dataDir(t, { actions: { saved: [key], skipped: [], applied: [] }, tracker: { 'Other|Role': other } });
  await withServer(dir, async base => {
    const applied = await event(base, { action: 'apply', key });
    assert.equal(applied.body.tracker, undefined, 'the full tracker is not sent');
    assert.equal(applied.body.trackerChange.key, key);
    assert.deepEqual(applied.body.trackerChange.entry, read(dir, 'role-tracker.json')[key]);
    assert.equal(applied.body.trackerChange.entry.stage, 'applied');
    const undone = await event(base, { action: 'undo' });
    assert.deepEqual(undone.body.trackerChange, { key, entry: null });
    // Intel saves its client copy with that one change merged in: the undone role stays unapplied after a reload.
    const client = { 'Other|Role': other, [key]: applied.body.trackerChange.entry };
    delete client[undone.body.trackerChange.key];
    await fetch(`${base}/api/role-tracker`, post(client));
    const reloaded = await fetch(`${base}/api/role-actions`).then(res => res.json());
    assert.ok(!reloaded.applied.includes(key));
    assert.deepEqual(await fetch(`${base}/api/role-tracker`).then(res => res.json()), { 'Other|Role': other });
    const duplicate = await event(base, { action: 'skip', key: 'Other|Role' });
    const again = await event(base, { action: 'skip', key: 'Other|Role' });
    assert.equal(again.body.duplicate, true);
    assert.deepEqual(again.body.trackerChange, { key: 'Other|Role', entry: other });
    assert.equal(duplicate.status, 200);
  });
});

test('a retried apply whose first response was lost still returns the stored tracker entry, so an Intel save keeps it', async t => {
  const key = 'Acme|Senior SWE';
  const other = { stage: 'onsite', notes: 'keep me' };
  const dir = dataDir(t, { actions: { saved: [key], skipped: [], applied: [] }, tracker: { 'Other|Role': other } });
  await withServer(dir, async base => {
    await event(base, { action: 'apply', key }); // the client never saw this response
    const stored = read(dir, 'role-tracker.json')[key];
    const retry = await event(base, { action: 'apply', key });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.deepEqual(retry.body.trackerChange, { key, entry: stored });
    // The client merges that entry into its stale copy before Intel saves the whole tracker.
    const client = { 'Other|Role': other };
    client[retry.body.trackerChange.key] = retry.body.trackerChange.entry;
    await fetch(`${base}/api/role-tracker`, post(client));
    assert.deepEqual(read(dir, 'role-tracker.json')[key], stored);
    assert.ok((await fetch(`${base}/api/role-actions`).then(res => res.json())).applied.includes(key));
    assert.equal(read(dir, 'role-history.json').events.filter(e => e.action === 'apply' && e.key === key).length, 1, 'the retry adds no second apply event');
  });
});
