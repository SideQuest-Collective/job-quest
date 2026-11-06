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
  vm.runInNewContext(['nativeRoleStatus', 'nativeRoleKey', 'asNativeRole', 'unseenNativeRoles'].map(pick).join('\n') + '\nthis.fns = { unseenNativeRoles, nativeRoleKey, asNativeRole };', context);
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
  assert.match(html, /setRoleLaunch\(\{ key: role\.roleKey \|\| `\$\{role\.company\}\|\$\{role\.role\}`/);
  assert.match(html, /const key = nativeRoleKey\(r, roleActions, roleTracker\);/);
});

test('carousel decisions post one per-role event, never the full client-side state', async () => {
  assert.doesNotMatch(discover, /api\.post\('\/api\/role-actions',/);
  const handler = discover.match(/  const doAction = async \(action\) => \{[\s\S]*?\n  \};/)[0];
  const calls = [], actions = [], histories = [];
  const role = { company: 'Acme', role: 'Senior SWE', url: 'https://jobs.lever.co/acme/62ac428a-80ef-4469-9e06-0b87ed4f206f', keys: ['Acme|Senior SWE', 'Acme|Sr. SWE'] };
  const doAction = new Function('actionBusy', 'unseen', 'currentIdx', 'setSwipeDir', 'setActionBusy', 'setActionError', 'api', 'applyEventResult', 'keysOf', `${handler}\nreturn doAction;`)(
    false, [role], 0, () => {}, () => {}, () => {},
    { post: async (url, body) => { calls.push({ url, body }); return { actions: { saved: [], skipped: ['Acme|Senior SWE'], applied: [] }, history: { handled: [], undo: { id: 'e1' } } }; } },
    result => { actions.push(result.actions); histories.push(result.history); }, r => r.keys);
  await doAction('skip');
  assert.deepEqual(calls, [{ url: '/api/role-actions/event', body: { action: 'skip', key: 'Acme|Senior SWE', keys: ['Acme|Senior SWE', 'Acme|Sr. SWE'], url: role.url } }]);
  assert.deepEqual(actions[0].skipped, ['Acme|Senior SWE'], 'state comes from the server response');
  assert.equal(histories[0].undo.id, 'e1');
});

test('Undo reverts the server ledger target, refocuses the restored card, and is shown on both carousel states', async () => {
  assert.equal((discover.match(/<DiscoverUndo target=\{undoTarget\} busy=\{actionBusy\} onUndo=\{undoLast\} \/>/g) || []).length, 2);
  assert.match(discover, /const undoTarget = roleHistory\?\.undo \|\| null;/);
  assert.match(html, /function DiscoverUndo\(\{ target, busy, onUndo \}\)[\s\S]*?Undo \{label\}: \{target\.company\}/);
  const handler = discover.match(/  const undoLast = async \(\) => \{[\s\S]*?\n  \};/)[0];
  for (const failed of [false, true]) {
    const calls = [], focus = [], errors = [], views = [];
    const undoLast = new Function('actionBusy', 'undoTarget', 'setActionBusy', 'setActionError', 'api', 'applyEventResult', 'setViewMode', 'setFocusKey', 'setRoleHistory', `${handler}\nreturn undoLast;`)(
      false, { id: 'e2', key: 'Acme|Senior SWE', action: 'skip' }, () => {}, value => errors.push(value),
      { post: async (url, body) => { calls.push({ url, body }); if (failed) throw Error('Only the most recent Discover action can be undone.'); return { undone: { key: 'Acme|Senior SWE' } }; }, get: async () => ({ undo: null }) },
      () => {}, value => views.push(value), value => focus.push(value), () => {});
    await undoLast();
    assert.deepEqual(calls, [{ url: '/api/role-actions/event', body: { action: 'undo', eventId: 'e2', key: 'Acme|Senior SWE' } }]);
    if (failed) { assert.equal(errors.at(-1), 'Only the most recent Discover action can be undone.'); assert.deepEqual(focus, []); }
    else { assert.deepEqual(focus, ['Acme|Senior SWE']); assert.deepEqual(views, ['discover']); }
  }
  assert.match(html, /api\.get\('\/api\/role-history'\)\.then\(setRoleHistory\)/, 'undo target reloads from the server ledger');
});

test('Discover merges only the changed tracker entry, keeping unsaved Intel edits to other roles', () => {
  assert.match(html, /<Discover [^>]*setRoleTracker=\{setRoleTracker\}/);
  assert.match(discover, /function Discover\(\{[^}]*setRoleTracker = \(\) => \{\}/);
  const handler = discover.slice(discover.indexOf('const applyEventResult'), discover.indexOf('const doAction'));
  assert.ok(!/setRoleTracker\(result\.tracker\)/.test(handler), 'never replaces the whole tracker');
  const confirm = discover.slice(discover.indexOf('const confirmApply'), discover.indexOf('return ('));
  assert.match(confirm, /applyEventResult\(result\)/);
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
