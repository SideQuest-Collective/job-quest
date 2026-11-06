const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const discover = html.slice(html.indexOf('function Discover('), html.indexOf('/* ===== APPLY MODAL ===== */', html.indexOf('function Discover(')));
const UUID = '0b6c1f9e-1111-2222-3333-444455556666';

function helpers() {
  const context = { window: {}, URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/jobs/role-identity.js'), 'utf8'), context);
  const pick = name => html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];
  vm.runInNewContext(['nativeRoleStatus', 'undecidedRole', 'nativeRoleKey', 'asNativeRole', 'unseenNativeRoles'].map(pick).join('\n') + '\nthis.fns = { unseenNativeRoles, nativeRoleKey, asNativeRole };', context);
  return { ...context.fns, identity: context.window.JobQuestRoleIdentity };
}

test('Discover New hides roles handled under another URL form, title variant, ledger entry or tracker key', () => {
  const { unseenNativeRoles, identity } = helpers();
  const roles = identity.dedupeRoles([
    { date: '2026-11-05', roles: [
      { company: 'Oscar Health', role: 'Senior Software Engineer', url: 'https://www.hioscar.com/careers?gh_jid=1234567' },
      { company: 'Acme', role: 'Sr. Full-Stack Engineer - NYC', url: 'https://acme.example/jobs' },
      { company: 'Ledger Co', role: 'Staff Engineer', url: `https://jobs.ashbyhq.com/ledger/${UUID}/application` },
      { company: 'Tracked', role: 'Senior Platform Engineer' },
      { company: 'Fresh', role: 'Senior Backend Engineer' },
      { company: 'Acme', role: 'Staff Full-Stack Engineer' },
    ] },
  ]);
  const actions = { saved: [], skipped: ['Acme|Senior Fullstack Engineer'], applied: [] };
  const tracker = { 'Tracked|Senior Platform Engineer': { stage: 'discovered' } };
  // Unsaved after saving: present only in the ledger, under a different URL form and company name.
  const history = { handled: [
    { key: 'Oscar|Sr. Software Engineer', company: 'Oscar', title: 'Sr. Software Engineer', url: 'https://job-boards.greenhouse.io/oscar/jobs/1234567', action: 'save' },
    { key: 'Ledger Co|Staff Software Engineer, Platform', company: 'Ledger Co', title: 'Staff Software Engineer, Platform', url: `https://jobs.ashbyhq.com/ledger/${UUID}`, action: 'skip' },
  ] };
  const unseen = unseenNativeRoles(roles, actions, tracker, history);
  assert.deepEqual(JSON.parse(JSON.stringify(unseen.map(role => `${role.company}|${role.role}`))), ['Fresh|Senior Backend Engineer', 'Acme|Staff Full-Stack Engineer']);
  assert.equal(unseenNativeRoles(roles, actions, tracker, { handled: [] }).length, 4, 'ledger entries are what keep unsaved roles hidden');
});

test('collapsed roles open and list under the alias key that already has saved, applied or tracker state', () => {
  const { nativeRoleKey, asNativeRole } = helpers();
  const role = { company: 'Oscar Health', role: 'Senior Software Engineer', keys: ['Oscar Health|Senior Software Engineer', 'Oscar|Sr. Software Engineer'] };
  assert.equal(nativeRoleKey(role, { saved: ['Oscar|Sr. Software Engineer'] }, {}), 'Oscar|Sr. Software Engineer');
  assert.equal(nativeRoleKey(role, { saved: [] }, {}), 'Oscar Health|Senior Software Engineer');
  const opened = asNativeRole(role, 'Oscar|Sr. Software Engineer');
  assert.equal(opened.company, 'Oscar');
  assert.equal(opened.role, 'Sr. Software Engineer');
  assert.equal(opened.roleKey, 'Oscar|Sr. Software Engineer');
  assert.match(html, /const openNativeRole = useCallback\(role => \{\n    setRoleLaunch\(\{ key: role\.roleKey \|\| `\$\{role\.company\}\|\$\{role\.role\}`/);
  assert.match(html, /const key = nativeRoleKey\(r, roleActions, roleTracker\);/);
});

test('card and list decisions post one per-role event, never the full client-side state', async () => {
  assert.doesNotMatch(discover, /api\.post\('\/api\/role-actions',/);
  const handler = discover.match(/  const update=async\(role,action\)=>\{[\s\S]*?\n  \};/)[0];
  const mapping = discover.match(/  const EVENT_ACTIONS=\{[^}]*\};/)[0];
  const calls = [], actions = [], histories = [], selected = [];
  const role = { company: 'Acme', role: 'Senior SWE', url: 'https://jobs.lever.co/acme/62ac428a-80ef-4469-9e06-0b87ed4f206f', keys: ['Acme|Senior SWE', 'Acme|Sr. SWE'] };
  const update = new Function('busy', 'setBusy', 'setError', 'api', 'applyEventResult', 'keysOf', 'setSelectedKey', `${mapping}\n${handler}\nreturn update;`)(
    false, () => {}, () => {},
    { post: async (url, body) => { calls.push({ url, body }); return { actions: { saved: [], skipped: ['Acme|Senior SWE'], applied: [] }, history: { handled: [], undo: { id: 'e1' } } }; } },
    result => { actions.push(result.actions); histories.push(result.history); }, r => r.keys, value => selected.push(value));
  await update(role, 'dismiss');
  await update(role, 'like');
  await update({ ...role, company: 'Acme Co', roleKey: 'Acme|Sr. SWE' }, 'restore');
  await update(role, 'unknown');
  assert.deepEqual(calls.map(call => call.url), ['/api/role-actions/event', '/api/role-actions/event', '/api/role-actions/event']);
  assert.deepEqual(calls[0].body, { action: 'skip', key: 'Acme|Senior SWE', keys: ['Acme|Senior SWE', 'Acme|Sr. SWE'], url: role.url });
  assert.equal(calls[1].body.action, 'save');
  assert.equal(calls[2].body.action, 'restore');
  assert.equal(calls[2].body.key, 'Acme|Sr. SWE', 'a dismissed alias is restored under the key it was skipped as');
  assert.deepEqual(actions[0].skipped, ['Acme|Senior SWE'], 'state comes from the server response');
  assert.equal(histories[0].undo.id, 'e1');
  assert.deepEqual(selected, [null, null, null]);
});

test('Undo reverts the server ledger target, reselects the restored role, and is shared by card and list views', async () => {
  assert.equal((discover.match(/<DiscoverUndo target=\{undoTarget\} busy=\{busy\} onUndo=\{undo\} \/>/g) || []).length, 1);
  const render = discover.slice(discover.indexOf('  return <div className="discover-review">'));
  assert.ok(render.indexOf('<DiscoverUndo') < render.indexOf('listMode && <DiscoverList'), 'one Undo above both the list and card views');
  assert.match(discover, /const undoTarget=roleHistory\?\.undo \|\| null;/);
  assert.doesNotMatch(discover, /lastAction/, 'no separate in-memory undo');
  assert.match(html, /function DiscoverUndo\(\{ target, busy, onUndo \}\)[\s\S]*?\{label\} \{target\.company\} · \{target\.title\}\. <button[^>]*>Undo<\/button>/);
  assert.match(html, /const UNDO_LABELS = \{ skip: 'Dismissed', save: 'Saved', apply: 'Marked applied' \};/);
  const handler = discover.match(/  const undo=async\(\)=>\{[\s\S]*?\n  \};/)[0];
  const role = { company: 'Acme', role: 'Senior SWE', url: 'https://x.test/1', location: 'NYC' };
  for (const failed of [false, true]) {
    const calls = [], selected = [], errors = [], views = [], gets = [];
    const undo = new Function('busy', 'undoTarget', 'setBusy', 'setError', 'api', 'applyEventResult', 'setView', 'setSelectedKey', 'setRoleHistory', 'allRoles', 'keysOf', 'discoveryRoleId', `${handler}\nreturn undo;`)(
      false, { id: 'e2', key: 'Acme|Senior SWE', action: 'skip' }, () => {}, value => errors.push(value),
      { post: async (url, body) => { calls.push({ url, body }); if (failed) throw Error('Only the most recent Discover action can be undone.'); return { undone: { key: 'Acme|Senior SWE' } }; }, get: async url => { gets.push(url); return { undo: null }; } },
      () => {}, value => views.push(value), value => selected.push(value), () => {}, [role], r => [`${r.company}|${r.role}`], r => JSON.stringify([r.company, r.role, r.url, r.location]));
    await undo();
    assert.deepEqual(calls, [{ url: '/api/role-actions/event', body: { action: 'undo', eventId: 'e2', key: 'Acme|Senior SWE' } }]);
    if (failed) { assert.equal(errors.at(-1), 'Only the most recent Discover action can be undone.'); assert.deepEqual(selected, []); assert.deepEqual(gets, ['/api/role-history']); }
    else { assert.deepEqual(selected, [JSON.stringify(['Acme', 'Senior SWE', 'https://x.test/1', 'NYC'])]); assert.deepEqual(views, ['new']); }
  }
  assert.match(html, /api\.get\('\/api\/role-history'\)\.then\(value=>setChangedJson\(setRoleHistory,value\)\)/, 'undo target reloads from the server ledger on refresh');
});

test('Discover merges only the changed tracker entry, keeping unsaved Intel edits to other roles', () => {
  assert.match(html, /<Discover [^>]*setRoleTracker=\{setRoleTracker\}/);
  assert.match(discover, /function Discover\(\{[^}]*setRoleTracker = \(\) => \{\}/);
  const handler = discover.slice(discover.indexOf('const applyEventResult'), discover.indexOf('const EVENT_ACTIONS'));
  assert.ok(!/setRoleTracker\(result\.tracker\)/.test(handler), 'never replaces the whole tracker');
  assert.equal((html.match(/<Discover [^>]*setRoleTracker=\{setRoleTracker\}[^>]*setRoleHistory=\{setRoleHistory\}/g) || []).length, 2, 'card and list views');
  assert.match(discover, /applyEventResult\(await api\.post\('\/api\/role-actions\/event'/);
  // Run the real handler against a client tracker that holds an unsaved Intel edit.
  let tracker = { 'Other|Role': { stage: 'onsite', notes: 'unsaved edit' }, 'Acme|SWE': { stage: 'applied' } };
  const calls = { actions: null, history: null };
  const make = new Function('setRoleActions', 'setRoleTracker', 'setRoleHistory', `${handler.trim()}; return applyEventResult;`);
  const apply = make(v => { calls.actions = v; }, fn => { tracker = typeof fn === 'function' ? fn(tracker) : fn; }, v => { calls.history = v; });
  apply({ actions: { saved: [] }, trackerChange: { key: 'Acme|SWE', entry: null }, history: { undo: null } });
  assert.deepEqual(tracker, { 'Other|Role': { stage: 'onsite', notes: 'unsaved edit' } });
  apply({ trackerChange: { key: 'New|Role', entry: { stage: 'applied' } } });
  assert.deepEqual(tracker['New|Role'], { stage: 'applied' });
  assert.equal(tracker['Other|Role'].notes, 'unsaved edit');
  apply({ trackerChange: null });
  assert.equal(Object.keys(tracker).length, 2);
});
