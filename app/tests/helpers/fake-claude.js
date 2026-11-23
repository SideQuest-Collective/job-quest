#!/usr/bin/env node
// Fake `claude` CLI for T-0028 plugin tests. Never runs the real CLI and only
// touches the Claude config dir of the test's environment:
// $CLAUDE_CONFIG_DIR when set, else $HOME/.claude (a temporary HOME).
//
// Flags are strict. Each subcommand accepts only the options listed in SPEC,
// copied from `claude plugin <cmd> --help` of Claude Code 2.1.316; anything
// else exits 1 with "error: unknown option", like the real CLI. Notably
// `marketplace add` has `--scope` but no `-s` or `-y`, and `marketplace update`
// takes no `--scope` at all.
//
// FAKE_CLAUDE_MODE is a comma-separated list of:
//   ok           behave like a working CLI (default)
//   fail-install `claude plugin install` exits 1
//   fail-update  `claude plugin update` exits 1
//   no-record    `claude plugin install` exits 0 but records nothing
//   fail-marketplace every `claude plugin marketplace ...` command exits 1
//   fail-all     every invocation exits 1
// FAKE_CLAUDE_ADD_EXISTING: what `marketplace add` does when the name is taken:
//   fail (default) exits 1, replace re-points the marketplace and exits 0.
//   The real CLI's behaviour here is unknown, so tests run both.
// Every invocation appends JSON.stringify(argv) to FAKE_CLAUDE_LOG.
//
// Modeled behaviour (strict on purpose, where the real CLI is unknown):
//   - `plugin install <id>` is a no-op when the plugin is already recorded (no refresh).
//   - `plugin update <id>` re-copies the plugin only when the marketplace's version changed.
//   - `plugin marketplace remove <name>` leaves installed plugin records alone.
//   - `plugin marketplace add <dir>` stores the directory's real path.
//   - Every invocation drains stdin, so a caller that does not redirect stdin
//     loses whatever was left on it (the rest of install.sh under `curl | bash`).

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ID = 'job-quest@job-quest-local';
const MARKETPLACE = 'job-quest-local';
const SCOPES = new Set(['user', 'project', 'local']);

// command -> { value: flags that take a value, bool: flags that do not }
const SPEC = {
  'plugin marketplace add': { value: ['--scope'], bool: ['--json'] },
  'plugin marketplace update': { value: [], bool: ['--json'] },
  'plugin marketplace remove': { value: ['--scope'], bool: ['--json'] },
  'plugin marketplace list': { value: [], bool: ['--json'] },
  'plugin install': { value: ['-s', '--scope'], bool: ['-y', '--yes', '--json'] },
  'plugin update': { value: ['-s', '--scope'], bool: ['-y', '--yes', '--json'] },
  'plugin uninstall': { value: ['-s', '--scope'], bool: ['-y', '--yes', '--json', '--keep-data'] },
  'plugin list': { value: [], bool: ['--json'] },
};
const ALIASES = { plugins: 'plugin', i: 'install', rm: 'remove' };

// Parse argv into { cmd, args, flags, error }. `cmd` is the canonical command
// ("plugin install", "plugin marketplace add", ...), `args` its positionals.
function parse(argv) {
  const words = argv.map(String);
  const head = [];
  let rest = words;
  const take = () => { const w = rest[0]; rest = rest.slice(1); return ALIASES[w] || w; };
  if (!rest.length || rest[0].startsWith('-')) return { cmd: '', args: [], flags: {}, error: null };
  head.push(take());
  if (head[0] !== 'plugin') return { cmd: head[0], args: rest, flags: {}, error: null };
  if (!rest.length || rest[0].startsWith('-')) return { cmd: 'plugin', args: [], flags: {}, error: 'missing subcommand' };
  head.push(take());
  if (head[1] === 'marketplace') {
    if (!rest.length || rest[0].startsWith('-')) return { cmd: 'plugin marketplace', args: [], flags: {}, error: 'missing subcommand' };
    head.push(take());
  } else if (head[1] === 'remove') {
    head[1] = 'uninstall'; // `claude plugin uninstall|remove`
  }
  const cmd = head.join(' ');
  const spec = SPEC[cmd];
  if (!spec) return { cmd, args: rest, flags: {}, error: `unknown command '${cmd}'` };
  const args = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    if (!word.startsWith('-') || word === '-') { args.push(word); continue; }
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const name = eq > 0 ? word.slice(0, eq) : word;
    if (spec.value.includes(name)) {
      const value = eq > 0 ? word.slice(eq + 1) : rest[i += 1];
      if (value === undefined) return { cmd, args, flags, error: `option '${name}' argument missing` };
      flags[name === '-s' ? '--scope' : name] = value;
    } else if (spec.bool.includes(name) && eq < 0) {
      flags[name === '-y' ? '--yes' : name] = true;
    } else {
      return { cmd, args, flags, error: `unknown option '${name}'` };
    }
  }
  if (flags['--scope'] !== undefined && !SCOPES.has(flags['--scope'])) {
    return { cmd, args, flags, error: `invalid scope '${flags['--scope']}'` };
  }
  return { cmd, args, flags, error: null };
}

function claudeDirFor(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME, '.claude');
}

function pluginsDir(claudeDir) { return path.join(claudeDir, 'plugins'); }
function knownFile(claudeDir) { return path.join(pluginsDir(claudeDir), 'known_marketplaces.json'); }
function installedFile(claudeDir) { return path.join(pluginsDir(claudeDir), 'installed_plugins.json'); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readKnown(claudeDir) { return readJson(knownFile(claudeDir), {}); }
function readInstalled(claudeDir) {
  const data = readJson(installedFile(claudeDir), { version: 2, plugins: {} });
  data.plugins = data.plugins || {};
  return data;
}

// Seed an already-installed job-quest plugin: the marketplace record points at
// `marketplaceDir` and the cache holds `skill` at `version`. Nothing is read
// from marketplaceDir, so it works before the plugin package exists.
function seedInstalledPlugin(claudeDir, { version = '0.1.0', marketplaceDir, skill = '---\nname: job-quest\n---\nseeded\n' } = {}) {
  const known = readKnown(claudeDir);
  known[MARKETPLACE] = {
    source: { source: 'directory', path: marketplaceDir },
    installLocation: marketplaceDir,
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
  writeJson(knownFile(claudeDir), known);
  const installPath = path.join(pluginsDir(claudeDir), 'cache', MARKETPLACE, 'job-quest', version);
  fs.mkdirSync(path.join(installPath, 'skills', 'job-quest'), { recursive: true });
  fs.writeFileSync(path.join(installPath, 'skills', 'job-quest', 'SKILL.md'), skill);
  const installed = readInstalled(claudeDir);
  installed.plugins[PLUGIN_ID] = [{
    scope: 'user', installPath, version,
    installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z',
  }];
  writeJson(installedFile(claudeDir), installed);
  return installPath;
}

// Write an executable `claude` into stubsDir that runs this file with the PATH's node.
function writeFakeClaude(stubsDir) {
  const target = path.join(stubsDir, 'claude');
  fs.writeFileSync(target, `#!/bin/bash\nexec node ${JSON.stringify(__filename)} "$@"\n`, { mode: 0o755 });
  return target;
}

function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Index of the first logged call that is canonical command `cmd` and whose
// positionals start with `args`, or -1. Aliases (plugins, i, rm) are folded.
function callIndex(calls, cmd, args = []) {
  return calls.findIndex(argv => {
    const parsed = parse(argv);
    return parsed.cmd === cmd && args.every((part, i) => parsed.args[i] === part);
  });
}

function marketplacePlugin(claudeDir, marketplace, pluginName) {
  const entry = readKnown(claudeDir)[marketplace];
  if (!entry) return null;
  const root = entry.installLocation;
  const manifest = readJson(path.join(root, '.claude-plugin', 'marketplace.json'), null);
  if (!manifest || !Array.isArray(manifest.plugins)) return null;
  const plugin = manifest.plugins.find(p => p.name === pluginName);
  if (!plugin || typeof plugin.source !== 'string') return null;
  const dir = path.resolve(root, plugin.source);
  const pluginManifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'), {});
  return { dir, version: pluginManifest.version || plugin.version };
}

function doInstall(claudeDir, id, scope) {
  const [pluginName, marketplace] = id.split('@');
  const found = marketplacePlugin(claudeDir, marketplace, pluginName);
  if (!found || !found.version || !fs.existsSync(found.dir)) {
    process.stderr.write(`fake claude: plugin ${id} not found\n`);
    return 1;
  }
  const installPath = path.join(pluginsDir(claudeDir), 'cache', marketplace, pluginName, found.version);
  fs.rmSync(installPath, { recursive: true, force: true });
  fs.cpSync(found.dir, installPath, { recursive: true });
  const installed = readInstalled(claudeDir);
  const now = new Date().toISOString();
  installed.plugins[id] = [{ scope, installPath, version: found.version, installedAt: now, lastUpdated: now }];
  writeJson(installedFile(claudeDir), installed);
  process.stdout.write(`Successfully installed plugin: ${id}\n`);
  return 0;
}

function drainStdin() {
  if (process.stdin.isTTY) return;
  try { fs.readFileSync(0); } catch { /* closed or unreadable stdin is fine */ }
}

function main(argv) {
  const claudeDir = claudeDirFor(process.env);
  const modes = new Set((process.env.FAKE_CLAUDE_MODE || 'ok').split(',').map(s => s.trim()).filter(Boolean));
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\n');
  drainStdin();
  if (modes.has('fail-all')) return 1;
  const { cmd, args, flags, error } = parse(argv);
  if (cmd.split(' ')[0] !== 'plugin') return 0; // --version, -p and friends: not modelled
  if (error) { process.stderr.write(`error: ${error}\n`); return 1; }
  if (modes.has('fail-marketplace') && cmd.startsWith('plugin marketplace ')) {
    process.stderr.write('fake claude: marketplace command failed\n');
    return 1;
  }
  const scope = flags['--scope'] || 'user';
  const [a] = args;
  const known = readKnown(claudeDir);

  if (cmd === 'plugin marketplace add') {
    if (!a) { process.stderr.write("error: missing required argument 'source'\n"); return 1; }
    let dir;
    try { dir = fs.realpathSync(path.resolve(a)); } catch { process.stderr.write(`fake claude: no such directory ${a}\n`); return 1; }
    const manifest = readJson(path.join(dir, '.claude-plugin', 'marketplace.json'), null);
    if (!manifest || !manifest.name) { process.stderr.write('fake claude: no .claude-plugin/marketplace.json\n'); return 1; }
    if (known[manifest.name] && process.env.FAKE_CLAUDE_ADD_EXISTING !== 'replace') {
      process.stderr.write(`fake claude: marketplace '${manifest.name}' already exists\n`);
      return 1;
    }
    known[manifest.name] = { source: { source: 'directory', path: dir }, installLocation: dir, lastUpdated: new Date().toISOString() };
    writeJson(knownFile(claudeDir), known);
    process.stdout.write(`Successfully added marketplace: ${manifest.name}\n`);
    return 0;
  }
  if (cmd === 'plugin marketplace update') return !a || known[a] ? 0 : 1;
  if (cmd === 'plugin marketplace remove') {
    if (!a || !known[a]) { process.stderr.write(`fake claude: marketplace '${a}' not found\n`); return 1; }
    delete known[a];
    writeJson(knownFile(claudeDir), known);
    return 0;
  }
  if (cmd === 'plugin marketplace list') { process.stdout.write(Object.keys(known).join('\n') + '\n'); return 0; }

  const installed = readInstalled(claudeDir);
  if (cmd === 'plugin install') {
    if (modes.has('fail-install')) { process.stderr.write('fake claude: install failed\n'); return 1; }
    if (!a || !a.includes('@')) { process.stderr.write('fake claude: expected <plugin>@<marketplace>\n'); return 1; }
    if (!known[a.split('@')[1]]) { process.stderr.write('fake claude: marketplace not found\n'); return 1; }
    if (installed.plugins[a]) { process.stdout.write(`Plugin ${a} is already installed\n`); return 0; }
    if (modes.has('no-record')) return 0;
    return doInstall(claudeDir, a, scope);
  }
  if (cmd === 'plugin update') {
    if (modes.has('fail-update')) { process.stderr.write('fake claude: update failed\n'); return 1; }
    if (!a || !installed.plugins[a]) { process.stderr.write(`fake claude: ${a} is not installed\n`); return 1; }
    const [pluginName, marketplace] = a.split('@');
    const found = marketplacePlugin(claudeDir, marketplace, pluginName);
    if (!found) return 1;
    if (installed.plugins[a].some(entry => entry.version === found.version)) {
      process.stdout.write(`${a} is already at the latest version\n`);
      return 0;
    }
    return doInstall(claudeDir, a, scope);
  }
  if (cmd === 'plugin uninstall') {
    if (!a || !installed.plugins[a]) { process.stderr.write(`fake claude: ${a} is not installed\n`); return 1; }
    for (const entry of installed.plugins[a]) fs.rmSync(entry.installPath, { recursive: true, force: true });
    delete installed.plugins[a];
    writeJson(installedFile(claudeDir), installed);
    return 0;
  }
  if (cmd === 'plugin list') { process.stdout.write(Object.keys(installed.plugins).join('\n') + '\n'); return 0; }
  return 0;
}

// Commands an installer or uninstaller test must never reach for real. Each
// stub shadows the system binary on the stub PATH, records the call in
// TRIPWIRE_LOG and fails, so the test can assert the log stayed empty.
const TRIPWIRE_COMMANDS = ['launchctl', 'crontab', 'curl', 'wget', 'clang', 'open', 'osascript', 'brew', 'ssh', 'sudo'];

function writeTripwires(stubsDir, names = TRIPWIRE_COMMANDS) {
  for (const name of names) {
    fs.writeFileSync(path.join(stubsDir, name),
      `#!/bin/bash\necho "${name} $*" >> "$TRIPWIRE_LOG"\nexit 1\n`, { mode: 0o755 });
  }
}

function readTripwires(logFile) {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  MARKETPLACE,
  PLUGIN_ID,
  callIndex,
  claudeDirFor,
  installedFile,
  knownFile,
  parse,
  readInstalled,
  readKnown,
  readLog,
  readTripwires,
  seedInstalledPlugin,
  writeFakeClaude,
  writeTripwires,
};
