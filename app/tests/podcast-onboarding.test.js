const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const store = require('../lib/podcast/store');
const { createPodcastSchedule } = require('../lib/podcast/schedule');
const { registerPodcastRoutes } = require('../lib/podcast/routes');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('onboarding shows once, can be postponed, declined or reset, and never shows when configured', () => {
  const d = tmp('jq-onb-');
  const now = new Date('2026-10-15T12:00:00Z');
  assert.strictEqual(store.readOnboarding(d).status, 'pending');
  assert.ok(store.shouldShowOnboarding(store.readOnboarding(d), { configured: false, now }));
  assert.ok(!store.shouldShowOnboarding(store.readOnboarding(d), { configured: true, now }));

  const later = store.writeOnboarding(d, 'later', now);
  assert.ok(!store.shouldShowOnboarding(later, { configured: false, now }));
  assert.ok(store.shouldShowOnboarding(later, { configured: false, now: new Date(now.getTime() + (store.SNOOZE_DAYS + 0.1) * 86400000) }));

  assert.ok(!store.shouldShowOnboarding(store.writeOnboarding(d, 'skip', now), { configured: false, now }));
  assert.ok(!store.shouldShowOnboarding(store.writeOnboarding(d, 'done', now), { configured: false, now }));
  assert.ok(store.shouldShowOnboarding(store.writeOnboarding(d, 'reset', now), { configured: false, now }));
  assert.throws(() => store.writeOnboarding(d, 'nope'), /action must be/);
});

test('schedule control installs through the helper and reads the plist time', async () => {
  const home = tmp('jq-home-');
  const bin = tmp('jq-bin-');
  fs.writeFileSync(path.join(bin, 'install-podcast-schedule.sh'), '#!/bin/bash\n');
  const calls = [];
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.sidequest.job-quest.daily-podcast.plist');
  const exec = async (cmd, args) => {
    calls.push(args.slice(1));
    if (args[1] === '--uninstall') fs.rmSync(plist, { force: true });
    else {
      const [h, m] = args[1].split(':');
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, `<dict><key>Hour</key><integer>${Number(h)}</integer><key>Minute</key><integer>${Number(m)}</integer></dict>`);
    }
    return { stdout: '' };
  };
  const s = createPodcastSchedule({ binDir: bin, exec, platform: 'darwin', home });
  assert.deepStrictEqual(await s.status(), { installed: false, time: null });
  assert.deepStrictEqual(await s.install('7:45'), { installed: true, time: '07:45' });
  await assert.rejects(s.install('25:00'), /Time must look like/);
  assert.deepStrictEqual(await s.uninstall(), { installed: false, time: null });
  assert.deepStrictEqual(calls, [['7:45'], ['--uninstall']]);
  const missing = createPodcastSchedule({ binDir: tmp('jq-empty-'), exec, platform: 'darwin', home });
  await assert.rejects(missing.install('08:30'), /not installed yet/);
});

test('onboarding routes: auto-show, decline, key + schedule complete the setup', async (t) => {
  const d = path.join(tmp('jq-onb-routes-'), 'data'); // secrets land in the sibling config/ folder
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'role-tracker.json'), JSON.stringify({ 'Citadel|SWE': { stage: 'onsite' } }));
  let installed = null;
  const schedule = {
    status: async () => (installed ? { installed: true, time: installed } : { installed: false, time: null }),
    install: async (time) => { installed = time; return { installed: true, time }; },
    uninstall: async () => { installed = null; return { installed: false, time: null }; },
  };
  const app = express();
  app.use(express.json());
  // Saving a key runs a test recording; answer it with audio so the key counts as connected.
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ content: [{ type: 'audio', data: Buffer.alloc(2400).toString('base64') }] }] }) });
  registerPodcastRoutes(app, { dataDir: d, schedule, fetchFn });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  delete process.env.GEMINI_API_KEY;

  let o = (await call('GET', '/api/podcast/onboarding')).body;
  assert.strictEqual(o.show, true);
  assert.strictEqual(o.content.roles, 1);
  assert.strictEqual(o.imessageAvailable, false);

  await call('POST', '/api/podcast/onboarding', { action: 'skip' });
  assert.strictEqual((await call('GET', '/api/podcast/onboarding')).body.show, false);
  assert.strictEqual((await call('POST', '/api/podcast/onboarding', { action: 'bogus' })).status, 400);

  await call('POST', '/api/podcast/onboarding', { action: 'reset' });
  await call('PUT', '/api/podcast/config', { apiKey: 'k-123' });
  const sch = await call('PUT', '/api/podcast/schedule', { time: '07:15' });
  assert.deepStrictEqual(sch.body.schedule, { installed: true, time: '07:15' });
  assert.strictEqual(store.readConfig(d).hour, 7);
  o = (await call('GET', '/api/podcast/onboarding')).body;
  assert.strictEqual(o.hasKey, true);
  assert.strictEqual(o.key.verified, true);
  assert.strictEqual(o.show, false, 'configured means no auto-show even while pending');
});

test('podcast configuration is mounted inside Setup without a global onboarding popup', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  const setup = fs.readFileSync(path.join(__dirname, '..', 'public', 'setup.jsx'), 'utf-8');
  assert.match(html, /src="\/daily-drop.jsx"/);
  assert.match(html, /src="\/setup.jsx"/);
  assert.match(html, /<window\.JobQuestSetup/);
  assert.doesNotMatch(html, /<window\.DailyDropOnboarding/);
  assert.match(setup, /<window\.DailyDropSetupCard active=/);
});
