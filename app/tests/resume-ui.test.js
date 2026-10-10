// app/tests/resume-ui.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');

// Execute the component's non-JSX logic and the actual JSX visibility expressions.
function tailoredCardHarness(hookResult, resumeApi = {}, props = {}) {
  const card = html.slice(html.indexOf('function TailoredResumeCard('), html.indexOf('function AcceptedResumeLink('));
  const prefix = card.slice(0, card.indexOf('\n  return ('));
  const button = card.match(/\{([^\n]+) && <button[^\n]+>Tailor resume<\/button>\}/);
  const description = card.match(/\{([^\n]+) && <div[^\n]+>Builds a version/);
  const errorLine = card.match(/\{([^\n]+) && <div[^\n]+>\{([^\n]+)\}<\/div>\}/);
  assert.ok(button && description && errorLine, 'card visibility and error expressions exist');
  const state = [];
  let cursor = 0;
  const window = new EventTarget();
  const component = new Function('useTailoredRecord', 'useState', 'useEffect', 'resumeApi', 'RM_ACTIVE', 'window', `${prefix}
    return { accept, busy, error, errorLine: (${errorLine[1]}) ? (${errorLine[2]}) : '', emptyButton: !!(${button[1]}), emptyDescription: !!(${description[1]}) };
  }
  return TailoredResumeCard;`)(
    () => hookResult,
    (initial) => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => { state[index] = value; }];
    },
    () => {}, resumeApi, ['queued', 'running'], window,
  );
  return { window, render() { cursor = 0; return component({ roleKey: 'Initech|Engineer', ...props }); } };
}

test('failed tailored list GET exposes an error without an empty state or losing accepted records', async () => {
  const source = html.match(/function useTailoredRecord\(roleKey, recordId = null\) \{[\s\S]*?\n\}/);
  assert.ok(source, 'tailored record hook exists');
  const states = [];
  let cursor = 0, response;
  const hook = new Function('useState', 'useCallback', 'useEffect', 'resumeApi', 'RM_ACTIVE', `${source[0]}\nreturn useTailoredRecord;`)(
    (initial) => {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = value; }];
    }, (fn) => fn, () => {},
    { get(url) { assert.equal(url, '/api/resume/tailored'); return response(); } }, ['queued', 'running'],
  );
  const render = () => { cursor = 0; return hook('Initech|Engineer'); };
  response = async () => { throw new Error('List unavailable'); };
  await render().reload();
  let result = render();
  assert.equal(result.error, 'List unavailable');
  assert.equal(result.loaded, false, 'a failed first request is not a loaded empty list');
  let card = tailoredCardHarness(result).render();
  assert.ok(card, 'initial list failure is visible');
  assert.equal(card.errorLine, 'List unavailable');
  assert.equal(card.emptyButton, false);
  assert.equal(card.emptyDescription, false);

  const accepted = { id: 'r1', roleKeys: ['Initech|Engineer'], status: 'done', accepted: true };
  response = async () => [accepted];
  await result.reload();
  result = render();
  assert.equal(result.error, '');
  response = async () => { throw new Error('Poll unavailable'); };
  await result.reload();
  result = render();
  assert.equal(result.error, 'Poll unavailable');
  assert.equal(result.record, accepted, 'a failed poll retains the accepted record');
  card = tailoredCardHarness(result).render();
  assert.equal(card.errorLine, 'Poll unavailable');
  assert.equal(card.emptyButton, false);
  assert.equal(card.emptyDescription, false);
  const link = html.slice(html.indexOf('function AcceptedResumeLink('), html.indexOf('/* ===== TASKS ===== */'));
  const linkPrefix = link.slice(0, link.indexOf('\n  return ('));
  const acceptedLink = new Function('useTailoredRecord', `${linkPrefix}\nreturn record.id;\n}\nreturn AcceptedResumeLink;`)(() => result);
  assert.equal(acceptedLink({ roleKey: 'Initech|Engineer', stage: 'applied' }), 'r1');

  let resolve;
  response = () => new Promise((done) => { resolve = done; });
  const pending = result.reload();
  assert.equal(render().error, '', 'each load clears the preceding error immediately');
  resolve([]);
  await pending;
  card = tailoredCardHarness(render()).render();
  assert.equal(card.emptyButton, true, 'a successful empty list shows the tailor action');
  assert.equal(card.emptyDescription, true);
});

test('Accept reloads and notifies subscribers when the tracker refresh rejects', async () => {
  const steps = [];
  const harness = tailoredCardHarness(
    { record: { id: 'r1' }, loaded: true, async reload() { steps.push('reload'); } },
    { async send(method, url) { assert.equal(method, 'POST'); assert.equal(url, '/api/resume/tailored/r1/accept'); steps.push('accepted'); } },
    { async onAccepted() { steps.push('tracker'); throw new Error('Tracker unavailable'); } },
  );
  harness.window.addEventListener('resume-tailored-updated', () => steps.push('notified'));
  await harness.render().accept();
  assert.deepEqual(steps, ['accepted', 'tracker', 'reload', 'notified']);
  assert.equal(harness.render().errorLine, 'Tracker unavailable');
  assert.equal(harness.render().busy, false);
});

test('Accept works when the onAccepted prop is omitted', async () => {
  const steps = [];
  const harness = tailoredCardHarness(
    { record: { id: 'r1' }, loaded: true, async reload() { steps.push('reload'); } },
    { async send() { steps.push('accepted'); } },
  );
  await harness.render().accept();
  assert.equal(harness.render().error, '', 'omitting onAccepted does not produce a TypeError');
  assert.deepEqual(steps, ['accepted', 'reload']);
  assert.equal(harness.render().busy, false);
});

test('Resume Manager has a Master editor wired to the master API', () => {
  assert.ok(html.includes('function MasterEditor({ onExit })'));
  // The Master tab shows the overview and switches into the structured editor in place.
  assert.ok(html.includes("if (editing) return <MasterEditor onExit={() => setEditing(false)} />;"));
  assert.ok(html.includes("onOpenMaster={() => setEditing(true)}"));
  assert.ok(html.includes("resumeApi.send('PUT', '/api/resume/master'"));
  assert.ok(html.includes("'/api/resume/master/import-latex'"));
  assert.equal(html.split("setView('master')").length - 1, 0, 'the LaTeX editor no longer carries its own Master link; the tab bar does');
});

const editor = html.slice(html.indexOf('function MasterEditor({ onExit })'), html.indexOf('/* ===== TASKS ===== */'));

test('Master editor confirms before leaving unsaved edits', () => {
  assert.ok(editor.includes("onClick={() => { if (!dirty || window.confirm('Discard unsaved changes?')) onExit(); }}"));
});

test('Master editor disables Save while saving and preserves edits made during the PUT', async () => {
  assert.ok(editor.includes('const [saving, setSaving] = useState(false);'));
  assert.ok(editor.includes('disabled={!dirty || saving} onClick={save}'));
  assert.ok(editor.includes('setMaster((cur) =>'));

  // Exercise the actual save handler without a browser or JSX transform.
  const saveSource = editor.match(/  const save = async \(\) => \{[\s\S]*?\n  \};/)[0];
  for (const outcome of ['unchanged', 'edited', 'rejected']) {
    const sent = { headline: 'Original', contact: { links: ['  example.com  '] } };
    const cleaned = { ...sent, contact: { links: ['example.com'] } };
    const echo = { ...cleaned, updatedAt: 'server timestamp' };
    let current = sent;
    let savedJson = 'previous saved state';
    let saving = false;
    let errors = [];
    let resolvePut, rejectPut;
    const put = new Promise((resolve, reject) => { resolvePut = resolve; rejectPut = reject; });
    const save = new Function('master', 'saving', 'resumeApi', 'rmClean', 'setMaster', 'setSavedJson', 'setSaving', 'setErrors', 'setStatus', `${saveSource}\nreturn save;`)(
      sent, saving,
      { send(method, url, payload) {
        assert.equal(method, 'PUT');
        assert.equal(url, '/api/resume/master');
        assert.deepEqual(payload, cleaned);
        assert.equal(saving, true);
        return put;
      } },
      () => cleaned,
      (update) => { current = typeof update === 'function' ? update(current) : update; },
      (value) => { savedJson = value; },
      (value) => { saving = value; },
      (value) => { errors = value; },
      () => {},
    );
    const pending = save();
    const edited = { ...sent, headline: 'Typed while saving' };
    if (outcome === 'edited') current = edited;
    if (outcome === 'rejected') rejectPut(new Error('Save failed'));
    else resolvePut(echo);
    await pending;
    assert.equal(saving, false, `${outcome}: save becomes available again`);
    assert.equal(current, outcome === 'edited' ? edited : outcome === 'rejected' ? sent : echo);
    assert.equal(savedJson, outcome === 'rejected' ? 'previous saved state' : JSON.stringify(echo));
    assert.deepEqual(errors, outcome === 'rejected' ? ['Save failed'] : []);
  }
});

test('Master editor confirms before replacing unsaved edits with an import', () => {
  assert.ok(editor.includes("onClick={() => { if (!dirty || window.confirm('Replace your unsaved edits with the imported resume?')) { setMaster(proposal.proposed); setProposal(null); } }}"));
});

test('Master editor has up and down controls for employers, roles, and projects', () => {
  for (const [delta, arrow] of [[-1, '↑'], [1, '↓']]) {
    assert.ok(editor.includes(`onClick={() => patch({ experience: rmMove(master.experience, ei, ${delta}) })}>${arrow}</button>`), `employers ${arrow}`);
    assert.ok(editor.includes(`onClick={() => setListItem('experience', ei, { roles: rmMove(e.roles, ri, ${delta}) })}>${arrow}</button>`), `roles ${arrow}`);
    assert.ok(editor.includes(`onClick={() => patch({ projects: rmMove(master.projects, pi, ${delta}) })}>${arrow}</button>`), `projects ${arrow}`);
  }
});

test('the Intel role page shows the tailored-resume card and the accepted-PDF link', () => {
  assert.ok(html.includes('function TailoredResumeCard({ roleKey, recordId = null, onAccepted = async () => {} })'));
  assert.ok(html.includes('function AcceptedResumeLink({ roleKey, stage })'));
  assert.ok(html.includes("<TailoredResumeCard key={selectedKey} roleKey={selectedKey} onAccepted={() => api.get('/api/role-tracker').then(value => { if (!roleTrackerPendingRef.current) setRoleTracker(value); })} />"));
  assert.ok(html.includes('<AcceptedResumeLink roleKey={selectedKey} stage={stage} />'));
  assert.ok(html.includes('not supported by your master resume'));
  assert.ok(html.indexOf('<TailoredResumeCard key={selectedKey}') < html.indexOf('{/* Notes */}'));
  assert.ok(html.includes('return nativeRoleStatus(key, roleActions, roleTracker).stage;'));
  assert.ok(html.includes("{t.date?.split('T')[0]}"));
  assert.ok(html.includes('{t.event}'));
});

test('Master LaTeX import blocks duplicate requests and unlocks after success or failure', async () => {
  assert.ok(editor.includes('disabled={importing} onClick={importLatex}'));
  const source = editor.match(/  const importLatex = async \(\) => \{[\s\S]*?\n  \};/)[0];
  for (const fails of [false, true]) {
    let calls = 0, importing = false, proposal = null, errors = [], status = '';
    let resolve, reject;
    const request = new Promise((yes, no) => { resolve = yes; reject = no; });
    const importLatex = new Function('importInFlight', 'setImporting', 'setStatus', 'setErrors', 'setProposal', 'resumeApi', `${source}\nreturn importLatex;`)(
      { current: false }, (v) => { importing = v; }, (v) => { status = v; },
      (v) => { errors = v; }, (v) => { proposal = v; },
      { send(method, url) { calls++; assert.equal(method, 'POST'); assert.equal(url, '/api/resume/master/import-latex'); return request; } },
    );
    const pending = importLatex();
    assert.equal(importing, true);
    await importLatex();
    assert.equal(calls, 1);
    if (fails) reject(new Error('Conversion failed'));
    else resolve({ proposed: { headline: 'Imported' } });
    await pending;
    assert.equal(importing, false);
    assert.equal(status, '');
    assert.deepEqual(errors, fails ? ['Conversion failed'] : []);
    assert.equal(proposal?.proposed.headline, fails ? undefined : 'Imported');
  }
});

test('Accept awaits the server and refreshes the tracker only after success', async () => {
  for (const fails of [false, true]) {
    const steps = [];
    const harness = tailoredCardHarness(
      { record: { id: 'resume-1' }, loaded: true, async reload() { steps.push('reload'); } },
      { async send(method, url) { assert.equal(method, 'POST'); assert.equal(url, '/api/resume/tailored/resume-1/accept'); steps.push('accepted'); if (fails) throw new Error('Accept failed'); } },
      { async onAccepted() { await Promise.resolve(); steps.push('tracker refreshed'); } },
    );
    await harness.render().accept();
    assert.equal(harness.render().error, fails ? 'Accept failed' : '');
    assert.deepEqual(steps, fails ? ['accepted'] : ['accepted', 'tracker refreshed', 'reload']);
  }
});

test('tailored records poll active work and refresh other subscribers after mutations', async () => {
  const source = html.match(/function useTailoredRecord\(roleKey, recordId = null\) \{[\s\S]*?\n\}/);
  assert.ok(source, 'shared tailored-record hook exists');
  for (const status of ['queued', 'running', 'done', 'failed']) {
    const effects = [], timers = [], cleared = [], updates = [];
    const window = new EventTarget();
    let requests = 0;
    const hook = new Function('useState', 'useCallback', 'useEffect', 'resumeApi', 'RM_ACTIVE', 'setInterval', 'clearInterval', 'window', `${source[0]}\nreturn useTailoredRecord;`)(
      (initial) => [initial === null ? [{ id: 'r1', roleKeys: ['Initech|Engineer'], status }] : initial, (v) => updates.push(v)],
      (fn) => fn, (fn) => effects.push(fn),
      { async get(url) { assert.equal(url, '/api/resume/tailored'); requests++; return []; } }, ['queued', 'running'],
      (fn, ms) => { assert.equal(ms, 3000); timers.push(fn); return 42; }, (id) => cleared.push(id), window,
    );
    const result = hook('Initech|Engineer');
    assert.equal(result.record.status, status);
    assert.equal(result.loaded, true);
    const cleanups = effects.map((fn) => fn());
    await Promise.resolve();
    assert.equal(requests, 1);
    assert.equal(timers.length, ['queued', 'running'].includes(status) ? 1 : 0);
    window.dispatchEvent(new Event('resume-tailored-updated'));
    await Promise.resolve();
    assert.equal(requests, 2, 'accepted link also refreshes when idle');
    cleanups.forEach((fn) => fn && fn());
    window.dispatchEvent(new Event('resume-tailored-updated'));
    assert.equal(requests, 2, 'listener is removed on unmount');
    assert.deepEqual(cleared, timers.length ? [42] : []);
  }
  assert.ok(html.includes("window.dispatchEvent(new Event('resume-tailored-updated'))"));
});

test('Resume page opens on the Library tab with Master and LaTeX editor tabs', () => {
  assert.ok(html.includes("const RL_TABS = [['library', 'Library'], ['master', 'Master'], ['editor', 'LaTeX editor']];"));
  assert.ok(html.includes("return RL_TABS.some(([id]) => id === t) ? t : 'library';"));
  assert.ok(html.includes('function ResumeEditor({ resume, setResume })'));
  assert.ok(html.includes("<Resume resume={resume} setResume={setResume} active={page === 'resume'} setPage={setPage} onOpenRole={openNativeRole} />"));
  assert.ok(html.includes("{tab === 'master' && <ResumeMaster active={active && tab === 'master'} />}"), 'Master tab hosts the overview/import page');
  const lib = html.slice(html.indexOf('function ResumeLibrary('), html.indexOf('function Resume({'));
  assert.ok(lib.includes("resumeApi.get('/api/resume/library')"));
  assert.ok(lib.includes("`/api/resume/tailored/${r.id}/used`"));
  assert.ok(lib.includes("`/api/resume/tailored/${r.id}/run-now`"));
  assert.ok(lib.includes('<TailoredResumeCard roleKey={r.roleKeys[0]} recordId={r.id} />'), 'details reuse the full tailored card');
  assert.ok(lib.includes("onOpenRole({ company: key.slice(0, i), role: key.slice(i + 1) })"), 'Open in Intel uses the app-level role launch');
  assert.ok(!html.includes('jq-intel-focus'), 'no sessionStorage handoff remains');
});
