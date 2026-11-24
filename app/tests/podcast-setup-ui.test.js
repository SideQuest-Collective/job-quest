const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/daily-drop.jsx'), 'utf8');
const helpers = source.slice(source.indexOf("  const PODCAST_DRAFT ="), source.indexOf('  function DailyDropSetupCard('));
const controller = source.slice(source.indexOf('  function DailyDropSetupCard('), source.indexOf('    const control =')) + '\nreturn { info, draft, scheduleDraft, error, note, load, editConfig, editSchedule, saveConfig, saveSchedule, discard };\n}';
const clone = (value) => JSON.parse(JSON.stringify(value));
const defaultInfo = () => ({
  config: { targetMinutes: 20, hour: 8, minute: 30, imessage: true, model: 'saved-tts', sheetsPerRun: 3, topicsPerEpisode: 2, algorithmTopics: 1, hosts: [{ name: 'Maya', voice: 'Kore', role: 'teacher', style: 'patient' }, { name: 'Dev', voice: 'Puck', role: 'learner', style: 'curious' }] },
  schedule: { installed: false, time: null }, state: { status: 'pending' }, imessageConfigured: false, imessageAvailable: true, hasKey: false, key: { verified: false },
});
function harness({ initial = defaultInfo(), failSchedule = false, savedDraft } = {}) {
  const cells = [], effects = [], writes = [], requests = [], storage = new Map();
  if (savedDraft) storage.set('jq:podcast-setup-draft:v1', JSON.stringify(savedDraft));
  let index = 0, info = clone(initial), failed = false;
  const context = {
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    useRef(value) { const i = index++; if (!cells[i]) cells[i] = { current: value }; return cells[i]; },
    useState(value) { const i = index++; if (!(i in cells)) cells[i] = value; return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }]; },
    useEffect(fn) { effects.push(fn); },
    async req(url, method, body) {
      requests.push({ url, method });
      if (!method) return clone(info);
      writes.push({ url, method, body: clone(body) });
      if (url === '/api/podcast/schedule') {
        if (failSchedule && !failed) { failed = true; throw new Error('Schedule unavailable'); }
        info.schedule = { installed: body.enabled, time: body.enabled ? body.time : null };
        return { schedule: clone(info.schedule) };
      }
      info.config = { ...info.config, ...clone(body) }; info.imessageConfigured = true;
      return { config: clone(info.config) };
    },
  };
  vm.createContext(context);
  const component = vm.runInContext(helpers + controller + '\nDailyDropSetupCard', context);
  return { render() { index = 0; effects.length = 0; return component({ active: true }); }, storage, requests, writes, setInfo(next) { info = clone(next); } };
}
const submit = { preventDefault() {} };

test('status loading makes no writes and new setup does not silently opt into iMessage', async () => {
  const h = harness(); let ui = h.render(); await ui.load(); ui = h.render();
  assert.equal(ui.draft.imessage, false);
  assert.equal(h.writes.length, 0);
  assert.equal(ui.scheduleDraft.enabled, false);
  assert.equal(ui.scheduleDraft.time, '08:30');
});

test('saved delivery and host metadata survive a preference edit', async () => {
  const info = defaultInfo(); info.imessageConfigured = true;
  const h = harness({ initial: info }); let ui = h.render(); await ui.load(); ui = h.render();
  assert.equal(ui.draft.imessage, true);
  ui.editConfig({ targetMinutes: '12' }); ui = h.render(); await ui.saveConfig(submit);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].url, '/api/podcast/config');
  assert.equal(h.writes[0].body.targetMinutes, 12);
  assert.equal(h.writes[0].body.imessage, true);
  assert.deepEqual(h.writes[0].body.hosts, info.config.hosts);
  assert.equal(h.storage.size, 0);
});

test('status refresh and page remount preserve unsaved drafts without saving them', async () => {
  const h = harness(); let ui = h.render(); await ui.load(); ui = h.render();
  ui.editConfig({ targetMinutes: '9' }); ui = h.render(); ui.editSchedule({ enabled: true, time: '07:15' });
  const remote = defaultInfo(); remote.config.targetMinutes = 18; h.setInfo(remote);
  ui = h.render(); await ui.load(); ui = h.render();
  assert.equal(ui.draft.targetMinutes, '9'); assert.equal(ui.scheduleDraft.time, '07:15');
  assert.equal(h.writes.length, 0);
  const restored = harness({ savedDraft: JSON.parse(h.storage.get('jq:podcast-setup-draft:v1')) });
  let next = restored.render(); await next.load(); next = restored.render();
  assert.equal(next.draft.targetMinutes, '9'); assert.equal(next.scheduleDraft.enabled, true);
  assert.equal(restored.writes.length, 0);
});

test('schedule failure preserves draft and explicit retry writes only the schedule', async () => {
  const h = harness({ failSchedule: true }); let ui = h.render(); await ui.load(); ui = h.render();
  ui.editSchedule({ enabled: true, time: '07:15' }); ui = h.render(); await ui.saveSchedule(submit); ui = h.render();
  assert.equal(ui.error, 'Schedule unavailable');
  assert.equal(ui.scheduleDraft.time, '07:15'); assert.ok(h.storage.size);
  await ui.saveSchedule(submit); ui = h.render();
  assert.equal(ui.error, ''); assert.equal(ui.info.schedule.installed, true);
  assert.ok(h.writes.every((write) => write.url === '/api/podcast/schedule'));
  assert.equal(h.storage.size, 0);
});

test('unavailable phone never clears a saved delivery preference', async () => {
  const info = defaultInfo(); info.imessageAvailable = false; info.imessageConfigured = true;
  const h = harness({ initial: info }); let ui = h.render(); await ui.load(); ui = h.render();
  assert.equal(ui.draft.imessage, true);
  ui.editConfig({ targetMinutes: 10 }); ui = h.render(); await ui.saveConfig(submit);
  assert.equal(Object.hasOwn(h.writes[0].body, 'imessage'), false);
  assert.equal(h.render().info.config.imessage, true);
});

test('invalid names prevent writes and schedule saves preserve unsaved preferences', async () => {
  const h = harness(); let ui = h.render(); await ui.load(); ui = h.render();
  ui.editConfig({ hosts: ui.draft.hosts.map((host) => ({ ...host, name: 'Same' })) }); ui = h.render(); await ui.saveConfig(submit);
  assert.match(h.render().error, /different name/); assert.equal(h.writes.length, 0);
  ui = h.render(); ui.editSchedule({ enabled: false }); ui = h.render(); await ui.saveSchedule(submit);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].body.enabled, false);
  assert.ok(JSON.parse(h.storage.get('jq:podcast-setup-draft:v1')).config);
});

test('work page routes settings to Setup and only Setup owns the voices controls', () => {
  const today = source.slice(source.indexOf('  function Today('), source.indexOf('  function Topics('));
  assert.doesNotMatch(today, /<VoicesCard/);
  assert.match(source, /new CustomEvent\('jq:open-setup', \{ detail: \{ section: 'podcast' \} \}\)/);
  assert.match(source, /state\.schedule && state\.schedule\.installed \?/);
  assert.doesNotMatch(helpers, /apiKey|geminiApiKey/);
});
