// T-0031: the Job Quest plugin manages schedules. It ships a report-only SessionStart hook
// that notes a missing daily intel schedule (never writes one) and a /job-quest:schedule
// command over the three schedule scripts. The hook runs from a copy of the plugin in a
// temporary "plugin cache", the way Claude Code runs it, against a temporary HOME
// (tests/helpers/schedule-home.js); never the real ~/.claude, launchctl or crontab.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, scheduleHome } = require('./helpers/schedule-home');
const { scheduleCron } = require('../lib/intel-control/routes');

const PLUGIN_DIR = path.join(ROOT, 'plugins', 'job-quest');
const HOOKS_JSON = path.join(PLUGIN_DIR, 'hooks', 'hooks.json');
const COMMAND = path.join(PLUGIN_DIR, 'commands', 'schedule.md');
const CHECKLIST = path.join(ROOT, 'docs', 'validation', 'dual-runtime-checklist.md');
const darwinOnly = { skip: process.platform !== 'darwin' && 'launchd plists are macOS only' };

function sessionStartGroups() {
  assert.ok(fs.existsSync(HOOKS_JSON), 'plugins/job-quest/hooks/hooks.json must exist');
  const config = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  return (config.hooks && config.hooks.SessionStart) || [];
}

function sessionStartHooks() {
  const startup = sessionStartGroups().filter(g => !g.matcher || g.matcher.split('|').includes('startup'));
  const hooks = startup.flatMap(g => g.hooks || []).filter(h => h.type === 'command');
  assert.ok(hooks.length > 0, 'a SessionStart command hook that runs on startup');
  return hooks;
}

// Run every startup SessionStart hook from a copy of the plugin outside the checkout.
function runHook(t, f) {
  const cache = path.join(f.dir, 'plugin-cache', 'job-quest');
  fs.cpSync(PLUGIN_DIR, cache, { recursive: true });
  const input = JSON.stringify({
    session_id: 'test-session', transcript_path: path.join(f.dir, 'transcript.jsonl'),
    cwd: f.home, hook_event_name: 'SessionStart', source: 'startup',
  });
  const contexts = [];
  for (const hook of sessionStartHooks()) {
    const result = spawnSync('/bin/sh', ['-c', hook.command], {
      cwd: f.home, env: { ...f.env, CLAUDE_PLUGIN_ROOT: cache }, input, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined, `hook must finish within its timeout: ${hook.command}`);
    assert.equal(result.status, 0, `a SessionStart hook never blocks the session: ${result.stdout}${result.stderr}`);
    const out = result.stdout.trim();
    if (!out) continue;
    if (out.startsWith('{')) {
      const reply = JSON.parse(out);
      const specific = reply.hookSpecificOutput;
      if (specific && specific.additionalContext) {
        assert.equal(specific.hookEventName, 'SessionStart');
        contexts.push(String(specific.additionalContext).trim());
      }
    } else {
      contexts.push(out);
    }
  }
  return contexts.filter(Boolean).join('\n');
}

function assertWroteNoSchedule(f, agentsBefore) {
  assert.deepEqual(f.agentFiles(), agentsBefore, 'the hook must not write or remove launchd plists');
  assert.deepEqual(f.launchctlCalls().filter(c => /^(load|unload|bootstrap|bootout|enable|disable)\b/.test(c)), [],
    'the hook must not load or unload launchd jobs');
  assert.deepEqual(f.crontabWrites(), [], 'the hook must not rewrite the crontab');
  assert.deepEqual(f.tripwires(), [], 'the hook must not reach the network, git, npm or open');
}

function assertUnknownNote(note) {
  assert.match(note, /unknown/i, `reported as unknown: ${JSON.stringify(note)}`);
  assert.doesNotMatch(note, /missing/i);
  assert.ok(note.includes('/job-quest:schedule'), `the note points at /job-quest:schedule: ${note}`);
  assert.equal(note.includes('\n'), false, `one line: ${JSON.stringify(note)}`);
}

test('plugin declares a SessionStart hook run through ${CLAUDE_PLUGIN_ROOT} with a short timeout', () => {
  for (const hook of sessionStartHooks()) {
    assert.ok(hook.command.includes('${CLAUDE_PLUGIN_ROOT}'), `hook runs from the plugin root: ${hook.command}`);
    assert.equal(typeof hook.timeout, 'number', 'hook sets an explicit timeout');
    assert.ok(hook.timeout > 0 && hook.timeout <= 15, `session start stays fast: timeout ${hook.timeout}`);
  }
});

test('SessionStart hook runs on startup only, not on every resume, clear or compact', () => {
  const groups = sessionStartGroups();
  assert.ok(groups.length > 0, 'a SessionStart hook group');
  for (const group of groups) {
    assert.equal(group.matcher, 'startup',
      `the schedule check loads the runtime and its note would repeat; matcher ${JSON.stringify(group.matcher)}`);
  }
});

test('SessionStart hook notes a missing daily intel schedule in one line and installs nothing', darwinOnly, t => {
  const f = scheduleHome(t);
  const note = runHook(t, f);
  assert.match(note, /daily intel/i);
  assert.match(note, /missing/i);
  assert.ok(note.includes('/job-quest:schedule'), `the note points at /job-quest:schedule: ${note}`);
  assert.equal(note.includes('\n'), false, `one line: ${JSON.stringify(note)}`);
  assertWroteNoSchedule(f, []);
});

test('SessionStart hook says nothing when the daily intel schedule is installed', darwinOnly, t => {
  const f = scheduleHome(t);
  f.writePlist('intel');
  const before = f.agentFiles();
  assert.equal(runHook(t, f), '');
  assertWroteNoSchedule(f, before);

  // An installed schedule needs no note, whatever state the preference file is in.
  const unreadable = scheduleHome(t);
  unreadable.writePlist('intel');
  unreadable.writeData('intel-schedule-preference.json', '{ "frequency": ');
  assert.equal(runHook(t, unreadable), '');
  assertWroteNoSchedule(unreadable, before);
});

test('SessionStart hook reports "unknown", not "missing", when the runtime fails to load', darwinOnly, t => {
  const f = scheduleHome(t, { runtime: 'crash' });
  assertUnknownNote(runHook(t, f));
  assertWroteNoSchedule(f, []);
});

test('SessionStart hook says nothing for a manual-only Intel choice or an external review schedule', darwinOnly, t => {
  const off = scheduleHome(t);
  off.writeData('intel-schedule-preference.json', {
    schema: 'job-quest-intel-schedule/1', frequency: 'off', time: null, cron: null,
    updatedAt: '2026-11-20T10:00:00.000Z', timeZone: 'America/Los_Angeles',
  });
  assert.equal(runHook(t, off), '', 'frequency "off": no schedule is expected, so no note of any kind');
  assertWroteNoSchedule(off, []);

  const external = scheduleHome(t);
  external.writeData('local-setup.json', { schedule: 'external' });
  assert.equal(runHook(t, external), '', 'schedule: external owns the daily review, so no note of any kind');
  assertWroteNoSchedule(external, []);
});

test('SessionStart hook reports "unknown", not "missing", when a preference file cannot be read', darwinOnly, t => {
  const broken = '{ "frequency": ';
  for (const name of ['intel-schedule-preference.json', 'local-setup.json']) {
    const f = scheduleHome(t);
    f.writeData(name, broken);
    const note = runHook(t, f);
    assert.match(note, /unknown/i, `${name} unreadable, so the hook cannot tell whether the schedule was turned off: ${JSON.stringify(note)}`);
    assertUnknownNote(note);
    assert.equal(fs.readFileSync(path.join(f.data, name), 'utf8'), broken, `the hook leaves ${name} as it found it`);
    assertWroteNoSchedule(f, []);
  }
});

test('SessionStart hook fails open when Job Quest is not installed in HOME', darwinOnly, t => {
  const f = scheduleHome(t, { install: false });
  const note = runHook(t, f);
  assert.doesNotMatch(note, /missing/i, 'without the installed scripts the hook cannot claim the schedule is missing');
  assertWroteNoSchedule(f, []);
});

function commandText() {
  assert.ok(fs.existsSync(COMMAND), 'plugins/job-quest/commands/schedule.md must exist');
  return fs.readFileSync(COMMAND, 'utf8');
}

// The text under the first Markdown heading that matches `name`, up to the next heading
// of the same or a higher level.
function section(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && name.test(line));
  assert.ok(start >= 0, `a heading matching ${name}`);
  const level = /^#+/.exec(lines[start])[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => { const m = /^(#{1,6})\s/.exec(line); return m && m[1].length <= level; });
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

// Every ```json fenced block in the text, parsed. A block that is not valid JSON fails the test.
function jsonBlocks(text) {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => {
    try { return JSON.parse(match[1]); } catch (error) {
      assert.fail(`a json block in schedule.md is not valid JSON (${error.message}):\n${match[1]}`);
    }
    return null;
  });
}

test('/job-quest:schedule command covers daily intel, trainer and podcast through the installed scripts', () => {
  const text = commandText();
  assert.match(text, /^---\n(?:[\s\S]*?\n)?description: *\S[\s\S]*?\n---\n/, 'frontmatter with a description');
  for (const script of ['install-schedule.sh', 'install-trainer-schedule.sh', 'install-podcast-schedule.sh']) {
    const full = `~/.job-quest/bin/${script}`;
    assert.ok(text.includes(full), `runs ${full} by its installed path`);
    assert.ok(text.includes(`${full} --exists`), `checks status with ${full} --exists`);
    assert.ok(text.includes(`${full} --uninstall`), `can remove with ${full} --uninstall`);
  }
  assert.ok(text.includes('3 7 * * 1-5'), 'offers the default weekday 7:03 AM daily intel schedule');
  assert.ok(text.includes('intel-schedule-preference.json'), 'records a daily intel removal as the manual-only preference');
  assert.match(text, /frequency[^\n]*off/i);
  assert.match(text, /unknown|could not (check|tell)/i, 'treats a failed check as unknown, not missing');
});

test('/job-quest:schedule daily intel section keeps the saved preference in step with the schedule', () => {
  const intel = section(commandText(), /daily intel/i);
  assert.ok(intel.includes('~/.job-quest/data/intel-schedule-preference.json'), 'names the preference file by its full path');
  const blocks = jsonBlocks(intel).filter(b => b && b.schema === 'job-quest-intel-schedule/1');

  // After a removal: the manual-only preference, or the SessionStart hook keeps reporting "missing".
  const off = blocks.find(b => b.frequency === 'off');
  assert.ok(off, 'a json example of the manual-only preference written after a removal');
  assert.equal(off.time, null);
  assert.equal(off.cron, null);
  for (const key of ['updatedAt', 'timeZone']) assert.ok(key in off, `the manual-only example has ${key}`);

  // After an install: frequency, time and cron describe the schedule that was installed,
  // in the shape Dashboard Setup writes (lib/intel-control/routes.js).
  const scheduled = blocks.find(b => b.frequency === 'daily' || b.frequency === 'weekdays');
  assert.ok(scheduled, 'a json example of the preference written after installing or changing the schedule');
  assert.equal(scheduleCron({ frequency: scheduled.frequency, time: scheduled.time }), scheduled.cron,
    `time ${scheduled.time} and cron ${scheduled.cron} must describe the same ${scheduled.frequency} schedule`);
  for (const key of ['updatedAt', 'timeZone']) assert.ok(key in scheduled, `the scheduled example has ${key}`);
  assert.match(intel, /\bdaily\b/);
  assert.match(intel, /\bweekdays\b/);
});

test('/job-quest:schedule daily intel section respects an external schedule and an unreadable preference', () => {
  const intel = section(commandText(), /daily intel/i);
  assert.ok(intel.includes('local-setup.json'), 'reads local-setup.json before installing');
  assert.match(intel, /schedule[^\n]*external|external[^\n]*schedule/i, 'handles schedule: external');
  assert.match(intel, /unreadable|malformed|invalid|corrupt|(cannot|can't|could not|can not) be (read|parsed)/i,
    'says what to do when the saved preference cannot be read');
  assert.match(intel, /overwrit|replac/i, 'an unreadable preference is kept, not overwritten');
});

test('/job-quest:schedule trainer section keeps trainer/config.json in step with the installed hours', () => {
  const trainer = section(commandText(), /trainer/i);
  assert.ok(trainer.includes('~/.job-quest/bin/install-trainer-schedule.sh'), 'installs through the trainer script');
  assert.ok(trainer.includes('9-21'), 'offers the default 9-21 hours');
  assert.ok(trainer.includes('~/.job-quest/data/trainer/config.json'), 'names the trainer config by its full path');
  assert.ok(trainer.includes('startHour') && trainer.includes('endHour'), 'updates startHour and endHour with the range');
});

test('/job-quest:schedule podcast section installs and removes the Daily Drop schedule', () => {
  const podcast = section(commandText(), /podcast/i);
  assert.ok(podcast.includes('~/.job-quest/bin/install-podcast-schedule.sh'), 'installs through the podcast script');
  assert.ok(podcast.includes('08:30'), 'offers the default 08:30 time');
});

test('validation checklist documents a /job-quest:schedule walkthrough with the state to verify', () => {
  const walkthrough = section(fs.readFileSync(CHECKLIST, 'utf8'), /job-quest:schedule/);
  for (const script of ['install-schedule.sh', 'install-trainer-schedule.sh', 'install-podcast-schedule.sh']) {
    assert.ok(walkthrough.includes(`~/.job-quest/bin/${script} --exists`), `verifies the result with ${script} --exists`);
  }
  assert.ok(walkthrough.includes('~/.job-quest/data/intel-schedule-preference.json'), 'verifies the saved intel preference');
  assert.match(walkthrough, /frequency[^\n]*off/i, 'covers removing daily intel (frequency off)');
  assert.match(walkthrough, /frequency[^\n]*(daily|weekdays)/i, 'covers reinstalling daily intel (frequency daily or weekdays)');
  assert.ok(walkthrough.includes('~/.job-quest/data/trainer/config.json'), 'verifies the trainer config');
  assert.ok(walkthrough.includes('startHour') && walkthrough.includes('endHour'), 'verifies the trainer hours');
  assert.match(walkthrough, /external/i, 'covers schedule: external');
  assert.match(walkthrough, /SessionStart|session start|new session/i, 'covers the start-of-session note');
});

test('plugin version is bumped so installed plugin caches pick up the hook and command', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const parts = String(plugin.version).split('.').map(Number);
  assert.equal(parts.length, 3);
  const newer = parts[0] > 0 || parts[1] > 1 || (parts[1] === 1 && parts[2] > 0);
  assert.ok(newer, `plugin.json version ${plugin.version} must be newer than 0.1.0`);
  const entry = marketplace.plugins.find(p => p.name === 'job-quest');
  assert.equal(entry.version, plugin.version);
});
