// app/tests/resume-on-demand-ui.test.js
// Tailoring is on demand: saved and applied roles offer a "Tailor resume" action, and nothing posts a request on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');
const action = html.slice(html.indexOf('function RoleTailorAction('), html.indexOf('function TailoredResumeCard('));
const discover = html.slice(html.indexOf('function Discover('), html.indexOf('function ApplyModal('));

// Run the action's non-JSX logic (record lookup and the click handler) without a JSX transform.
function actionHarness(records, resumeApi) {
  const prefix = action.slice(0, action.indexOf('\n  if (!record) return ('));
  assert.ok(prefix.includes('const tailor = async'), 'action logic exists');
  const state = [];
  let cursor = 0;
  const window = new EventTarget();
  const fn = new Function('useState', 'resumeApi', 'window', `${prefix}
    return { record, tailor, busy, error };
  }
  return RoleTailorAction;`)(
    (initial) => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => { state[index] = value; }];
    },
    resumeApi, window,
  );
  return { window, render(roleKey) { cursor = 0; return fn({ roleKey, records, onReview() {} }); } };
}

test('Discover saved and applied rows both render the on-demand tailor action from one shared fetch', () => {
  const uses = discover.match(/<RoleTailorAction roleKey=\{`\$\{r\.company\}\|\$\{r\.role\}`\} records=\{tailoredRecords\}/g) || [];
  assert.equal(uses.length, 2, 'one in the Saved tab, one in the Applied tab');
  assert.equal((discover.match(/useTailoredRecords\(\)/g) || []).length, 1);
  const saved = discover.slice(discover.indexOf("viewMode === 'saved'"), discover.indexOf("viewMode === 'applied'"));
  const applied = discover.slice(discover.indexOf("viewMode === 'applied'"));
  assert.ok(saved.includes('<RoleTailorAction') && applied.includes('<RoleTailorAction'));
});

test('the action shows "Tailor resume" only without a record, and otherwise shows the record state and opens the role', () => {
  assert.match(action, /if \(!record\) return \([\s\S]*Tailor resume[\s\S]*\);/);
  assert.match(action, /Resume: \{label\}/);
  assert.match(action, /onClick=\{onReview\}/, 'existing records open the full card (Retry, Accept, Reject)');
  assert.doesNotMatch(action, /useEffect/, 'rendering never starts tailoring');
});

test('a role without a record posts the manual request only when clicked', async () => {
  const calls = [];
  const h = actionHarness([], { async send(method, url, body) { calls.push([method, url, body]); return { created: true }; } });
  let updates = 0;
  h.window.addEventListener('resume-tailored-updated', () => { updates += 1; });
  const view = h.render('Initech|Engineer');
  assert.equal(view.record, null);
  assert.deepEqual(calls, [], 'rendering sends nothing');
  await view.tailor();
  assert.deepEqual(calls, [['POST', '/api/resume/tailored', { roleKey: 'Initech|Engineer' }]]);
  assert.equal(updates, 1, 'other resume views refresh');
});

test('an existing record is found by any of its role keys, preferring a non-failed one', () => {
  const records = [
    { id: 'old', roleKeys: ['Initech|Engineer'], status: 'failed' },
    { id: 'new', roleKeys: ['Initech|Senior Engineer', 'Initech|Engineer'], status: 'queued' },
  ];
  const h = actionHarness(records, { async send() { throw new Error('should not send'); } });
  assert.equal(h.render('Initech|Engineer').record.id, 'new');
  assert.equal(h.render('Other|Role').record, null);
});

test('the shared list fetch polls only while a record is queued or running', () => {
  const hook = html.match(/function useTailoredRecords\(\) \{[\s\S]*?\n\}/);
  assert.ok(hook);
  assert.match(hook[0], /RM_ACTIVE\.includes\(m\.status\)/);
  assert.match(hook[0], /'resume-tailored-updated'/);
  assert.doesNotMatch(hook[0], /send\(/, 'the hook only reads');
});

test('copy no longer promises automatic tailoring', () => {
  assert.doesNotMatch(html, /Save or apply to a role, or choose/);
  assert.doesNotMatch(html, /daily auto-tailor cap reached/);
});
