#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PRODUCT_HOME = '~/.job-quest';
const LEGACY_HOME = '~/.claude/job-quest';
const DEFAULT_SCHEMA_VERSION = '1.0';
const SUPPORTED_RUNTIME_IDS = new Set(['claude', 'codex']);
const CLAUDE_PLUGIN_NAME = 'job-quest';
const CLAUDE_MARKETPLACE = 'job-quest-local';
const CLAUDE_PLUGIN_ID = `${CLAUDE_PLUGIN_NAME}@${CLAUDE_MARKETPLACE}`;
const PLUGIN_SKILL_REL = path.join('skills', 'job-quest', 'SKILL.md');
const CHECKOUT_PLUGIN_DIR_REL = path.join('plugins', 'job-quest');

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function compactHome(input) {
  if (!input) return input;
  const home = os.homedir();
  const normalized = path.resolve(input);
  if (normalized === home) return '~';
  if (normalized.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, normalized)}`;
  }
  return input;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function detectRuntime(env = process.env, savedRuntime) {
  const explicit = (
    env.JOB_QUEST_RUNTIME ||
    env.JOBQUEST_RUNTIME ||
    env.JQ_RUNTIME ||
    ''
  ).toLowerCase();
  if (SUPPORTED_RUNTIME_IDS.has(explicit)) {
    return explicit;
  }
  if (SUPPORTED_RUNTIME_IDS.has(savedRuntime)) {
    return savedRuntime;
  }
  if (Object.keys(env).some(key => key.startsWith('CODEX_'))) {
    return 'codex';
  }
  return 'claude';
}

function makeCatalog() {
  return {
    claude: {
      displayName: 'Claude Code',
      registrationRoot: '~/.claude/skills',
      skillDir: '~/.claude/skills/job-quest',
      registrationFile: 'SKILL.md',
      command: 'claude',
      commandArgs: ['--print'],
      commandCandidates: [
        { command: 'claude', commandArgs: ['--print'] },
        { command: 'npx', commandArgs: ['-y', '@anthropic-ai/claude-code', '--print'] },
      ],
      entryMode: 'skill',
      pluginId: CLAUDE_PLUGIN_ID,
    },
    codex: {
      displayName: 'Codex',
      registrationRoot: '~/.codex/skills',
      skillDir: '~/.codex/skills/job-quest',
      registrationFile: 'SKILL.md',
      command: 'codex',
      commandArgs: ['exec'],
      commandCandidates: [
        { command: 'codex', commandArgs: ['exec'] },
      ],
      entryMode: 'skill',
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyRuntime(config, runtimeId) {
  const next = cloneJson(config);
  const catalogEntry = next.supportedRuntimes[runtimeId];
  next.activeRuntime = runtimeId;
  next.runtimeRegistrationRoot = catalogEntry.registrationRoot;
  next.runtimeSkillDir = catalogEntry.skillDir;
  next.runtimeRegistrationFile = catalogEntry.registrationFile;
  next.runtimeCommand = catalogEntry.command;
  next.runtimeCommandArgs = [...catalogEntry.commandArgs];
  next.runtimeDisplayName = catalogEntry.displayName;
  next.runtimeEntryMode = catalogEntry.entryMode;
  return next;
}

function buildDefaultConfig(runtimeId) {
  const supportedRuntimes = makeCatalog();
  return applyRuntime({
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    migrationState: 'ready',
    activeRuntime: runtimeId,
    detectedRuntime: runtimeId,
    productHomeDir: PRODUCT_HOME,
    pendingCanonicalHomeDir: PRODUCT_HOME,
    appDir: `${PRODUCT_HOME}/app`,
    dataDir: `${PRODUCT_HOME}/data`,
    binDir: `${PRODUCT_HOME}/bin`,
    referencesDir: `${PRODUCT_HOME}/references`,
    runtimeRegistrationRoot: '',
    runtimeSkillDir: '',
    runtimeRegistrationFile: '',
    runtimeCommand: '',
    runtimeCommandArgs: [],
    runtimeDisplayName: '',
    runtimeEntryMode: '',
    runtimeSwitchPolicy: 'persist-on-invoke',
    runtimeValidation: {
      status: 'pending',
      lastCheckedRuntime: runtimeId,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
    },
    supportedRuntimes,
  }, runtimeId);
}

function sanitizeConfig(parsed, runtimeId) {
  const defaults = buildDefaultConfig(runtimeId);
  const merged = {
    ...defaults,
    ...(parsed || {}),
    runtimeValidation: {
      ...defaults.runtimeValidation,
      ...((parsed && parsed.runtimeValidation) || {}),
    },
    supportedRuntimes: {
      ...defaults.supportedRuntimes,
      ...((parsed && parsed.supportedRuntimes) || {}),
    },
  };
  const activeRuntime = SUPPORTED_RUNTIME_IDS.has(merged.activeRuntime)
    ? merged.activeRuntime
    : runtimeId;
  return applyRuntime(merged, activeRuntime);
}

function getConfigPath(config) {
  return path.join(expandHome(config.productHomeDir), 'config', 'runtime.json');
}

function readConfig(configPath, runtimeId) {
  if (!fs.existsSync(configPath)) {
    return buildDefaultConfig(runtimeId);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return sanitizeConfig(parsed, runtimeId);
  } catch (error) {
    const broken = buildDefaultConfig(runtimeId);
    broken.runtimeValidation = {
      ...broken.runtimeValidation,
      status: 'degraded',
      lastFailureAt: new Date().toISOString(),
      lastFailureReason: `Invalid runtime config: ${error.message}`,
    };
    return broken;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function hasCommand(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0;
}

function resolveCommand(runtimeId, config) {
  const catalogEntry = config.supportedRuntimes[runtimeId];
  for (const candidate of catalogEntry.commandCandidates || []) {
    if (hasCommand(candidate.command)) {
      return {
        command: candidate.command,
        commandArgs: [...candidate.commandArgs],
      };
    }
  }
  return null;
}

// Claude Code keeps its state in $CLAUDE_CONFIG_DIR when set, else ~/.claude.
function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), '.claude');
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Symlinks (macOS /var vs /private/var, a linked home) must not make one directory look like two.
function sameDir(a, b) {
  const real = p => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function pluginEntries(env = process.env) {
  const installed = readJsonOrNull(path.join(claudeConfigDir(env), 'plugins', 'installed_plugins.json'));
  const entries = installed && installed.plugins && installed.plugins[CLAUDE_PLUGIN_ID];
  return Array.isArray(entries) ? entries.filter(entry => entry && typeof entry === 'object') : [];
}

// The installed job-quest plugin whose cached SKILL.md exists, user scope first, or null.
// With `userOnly`, project and local entries (registered for some other project) are ignored.
// A missing or malformed installed_plugins.json means "not installed".
function findClaudePlugin(env = process.env, options = {}) {
  const entries = pluginEntries(env);
  const ordered = [
    ...entries.filter(entry => entry.scope === 'user'),
    ...(options.userOnly ? [] : entries.filter(entry => entry.scope !== 'user')),
  ];
  for (const entry of ordered) {
    if (typeof entry.installPath !== 'string' || !entry.installPath) continue;
    const skillPath = path.join(entry.installPath, PLUGIN_SKILL_REL);
    if (fs.existsSync(skillPath)) {
      return { ...entry, skillPath };
    }
  }
  return null;
}

// Whether the installed plugin is current with the checkout at `source`: found,
// same version as the checkout's plugin.json, byte-identical SKILL.md, and the
// marketplace pointing at the checkout. Also reports the marketplace state
// ("absent", "current" or "other") and whether any plugin record exists.
function claudePluginStatus(source, env = process.env) {
  const checkout = path.resolve(source);
  const pluginDir = path.join(checkout, CHECKOUT_PLUGIN_DIR_REL);
  const known = readJsonOrNull(path.join(claudeConfigDir(env), 'plugins', 'known_marketplaces.json'));
  const marketplaceEntry = known && typeof known === 'object' ? known[CLAUDE_MARKETPLACE] : null;
  let marketplace = 'absent';
  let marketplacePath = null;
  if (marketplaceEntry && typeof marketplaceEntry === 'object') {
    marketplacePath = (marketplaceEntry.source && marketplaceEntry.source.path) || marketplaceEntry.installLocation || null;
    marketplace = typeof marketplacePath === 'string' && sameDir(marketplacePath, checkout) ? 'current' : 'other';
  }

  const record = pluginEntries(env).length > 0;
  // Only a user-scope install counts: a project or local one does not reach other projects,
  // so it must not let install.sh skip the user install and drop the fallback copy.
  const plugin = findClaudePlugin(env, { userOnly: true });
  const manifest = readJsonOrNull(path.join(pluginDir, '.claude-plugin', 'plugin.json'));
  const expectedVersion = manifest && manifest.version ? String(manifest.version) : null;
  const reasons = [];
  if (!plugin) reasons.push(`${CLAUDE_PLUGIN_ID} is not installed`);
  if (marketplace !== 'current') reasons.push(`${CLAUDE_MARKETPLACE} does not point at ${checkout}`);
  if (plugin) {
    if (!expectedVersion || String(plugin.version) !== expectedVersion) {
      reasons.push(`installed version ${plugin.version} differs from checkout version ${expectedVersion}`);
    }
    let same = false;
    try {
      same = fs.readFileSync(plugin.skillPath).equals(fs.readFileSync(path.join(pluginDir, PLUGIN_SKILL_REL)));
    } catch {
      same = false;
    }
    if (!same) reasons.push('installed SKILL.md differs from the checkout');
  }
  return {
    pluginId: CLAUDE_PLUGIN_ID,
    current: reasons.length === 0,
    marketplace,
    marketplacePath,
    record,
    installedVersion: plugin ? plugin.version : null,
    expectedVersion,
    skillPath: plugin ? plugin.skillPath : null,
    reasons,
  };
}

// The registration artifact for a runtime: for Claude the plugin's cached
// SKILL.md when installed, else the skill dir copy.
function registrationPathFor(config, runtimeId) {
  if (runtimeId === 'claude') {
    const plugin = findClaudePlugin();
    if (plugin) return plugin.skillPath;
  }
  const entry = config.supportedRuntimes[runtimeId];
  return path.join(expandHome(entry.skillDir), entry.registrationFile);
}

function validateRuntime(runtimeId, config, options = {}) {
  const requireRegistration = Boolean(options.requireRegistration);
  const next = applyRuntime(config, runtimeId);
  const resolvedCommand = resolveCommand(runtimeId, next);
  if (!resolvedCommand) {
    return {
      ok: false,
      config: next,
      reason: `No ${next.runtimeDisplayName} command found in PATH`,
    };
  }

  next.runtimeCommand = resolvedCommand.command;
  next.runtimeCommandArgs = resolvedCommand.commandArgs;

  if (requireRegistration) {
    const registrationPath = registrationPathFor(next, runtimeId);
    if (!fs.existsSync(registrationPath)) {
      const reason = runtimeId === 'claude'
        ? `Missing registration artifact: no Claude Code plugin ${CLAUDE_PLUGIN_ID} in ${path.join(claudeConfigDir(), 'plugins')} and no skill at ${registrationPath}`
        : `Missing registration artifact at ${registrationPath}`;
      return {
        ok: false,
        config: next,
        reason,
      };
    }
  }

  const sharedRunner = path.join(expandHome(next.binDir), 'start.sh');
  if (options.requireRunner && !fs.existsSync(sharedRunner)) {
    return {
      ok: false,
      config: next,
      reason: `Missing shared runner at ${sharedRunner}`,
    };
  }

  return { ok: true, config: next, reason: null };
}

function writeConfig(config) {
  const configPath = getConfigPath(config);
  // An unexpanded "~/..." would land in a literal "~" folder under the current directory.
  if (!path.isAbsolute(configPath)) {
    throw new Error(`Refusing to write runtime config to relative path ${configPath}`);
  }
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}

function ensureRuntime(options = {}) {
  const detectedRuntime = options.runtimeHint || detectRuntime();
  const productHome = expandHome(PRODUCT_HOME);
  const configPath = path.join(productHome, 'config', 'runtime.json');
  let config = readConfig(configPath, detectedRuntime);
  config.detectedRuntime = detectedRuntime;

  const shouldSwitch = options.allowSwitch !== false;
  const targetRuntime = shouldSwitch
    ? options.runtimeHint || detectRuntime(process.env, config.activeRuntime)
    : config.activeRuntime;
  const validation = validateRuntime(targetRuntime, config, {
    requireRegistration: options.requireRegistration,
    requireRunner: options.requireRunner,
  });

  if (validation.ok) {
    config = validation.config;
    config.runtimeValidation = {
      status: 'ready',
      lastCheckedRuntime: targetRuntime,
      lastSuccessAt: new Date().toISOString(),
      lastFailureAt: null,
      lastFailureReason: null,
    };
  } else {
    config.runtimeValidation = {
      status: config.activeRuntime === targetRuntime ? 'degraded' : 'ready',
      lastCheckedRuntime: targetRuntime,
      lastSuccessAt: config.runtimeValidation?.lastSuccessAt || null,
      lastFailureAt: new Date().toISOString(),
      lastFailureReason: validation.reason,
    };
  }

  if (options.write !== false) {
    try {
      writeConfig(config);
    } catch (error) {
      config.runtimeValidation = {
        ...config.runtimeValidation,
        status: config.runtimeValidation?.status === 'ready' ? 'ready' : 'degraded',
        lastFailureAt: new Date().toISOString(),
        lastFailureReason: `Could not write runtime config: ${error.message}`,
      };
    }
  }
  return config;
}

function toShellExports(config) {
  const runtimeRegistrationPath = config.activeRuntime === 'claude'
    ? registrationPathFor(config, 'claude')
    : path.join(expandHome(config.runtimeSkillDir), config.runtimeRegistrationFile);
  const lines = [
    `export JOB_QUEST_ACTIVE_RUNTIME=${shellQuote(config.activeRuntime)}`,
    `export JOB_QUEST_DETECTED_RUNTIME=${shellQuote(config.detectedRuntime)}`,
    `export JOB_QUEST_RUNTIME_DISPLAY_NAME=${shellQuote(config.runtimeDisplayName)}`,
    `export JOB_QUEST_PRODUCT_HOME=${shellQuote(expandHome(config.productHomeDir))}`,
    `export JOB_QUEST_APP_ROOT=${shellQuote(expandHome(config.appDir))}`,
    `export JOB_QUEST_DATA_DIR=${shellQuote(expandHome(config.dataDir))}`,
    `export JOB_QUEST_BIN_DIR=${shellQuote(expandHome(config.binDir))}`,
    `export JOB_QUEST_REFERENCES_DIR=${shellQuote(expandHome(config.referencesDir))}`,
    `export JOB_QUEST_RUNTIME_COMMAND=${shellQuote(config.runtimeCommand)}`,
    `export JOB_QUEST_RUNTIME_REGISTRATION_PATH=${shellQuote(runtimeRegistrationPath)}`,
    `export JOB_QUEST_SCHEDULE_INSTALL_COMMAND=${shellQuote(`${expandHome(config.binDir)}/install-schedule.sh "3 7 * * 1-5"`)}`
  ];
  const quotedArgs = (config.runtimeCommandArgs || []).map(shellQuote).join(' ');
  lines.push(`JOB_QUEST_RUNTIME_COMMAND_ARGS=( ${quotedArgs} )`);
  return lines.join('\n');
}

function printHelp() {
  console.error('Usage: node lib/runtime.js <command>');
  console.error('Commands: ensure, shell, detect, claude-plugin-status --source <checkout> [--field <name>]');
  console.error(`  claude-plugin-status prints JSON (or one field, booleans as yes/no) and exits 0 only when`);
  console.error(`  ${CLAUDE_PLUGIN_ID} is installed and current with <checkout>.`);
}

function cli(argv) {
  const [command, ...rest] = argv;
  const options = {
    write: !rest.includes('--no-write'),
    allowSwitch: !rest.includes('--no-switch'),
    requireRegistration: rest.includes('--require-registration'),
    requireRunner: rest.includes('--require-runner'),
  };

  if (command === 'detect') {
    console.log(detectRuntime());
    return 0;
  }

  if (command === 'ensure') {
    const config = ensureRuntime(options);
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }

  if (command === 'shell') {
    const config = ensureRuntime(options);
    console.log(toShellExports(config));
    return 0;
  }

  if (command === 'claude-plugin-status') {
    const sourceIndex = rest.indexOf('--source');
    const source = sourceIndex >= 0 ? rest[sourceIndex + 1] : undefined;
    if (!source) {
      printHelp();
      return 2;
    }
    const fieldIndex = rest.indexOf('--field');
    const status = claudePluginStatus(source);
    if (fieldIndex >= 0) {
      const value = status[rest[fieldIndex + 1]];
      console.log(typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value ?? ''));
    } else {
      console.log(JSON.stringify(status, null, 2));
    }
    return status.current ? 0 : 1;
  }

  printHelp();
  return 1;
}

if (require.main === module) {
  process.exit(cli(process.argv.slice(2)));
}

module.exports = {
  CLAUDE_PLUGIN_ID,
  PRODUCT_HOME,
  LEGACY_HOME,
  claudeConfigDir,
  claudePluginStatus,
  compactHome,
  detectRuntime,
  findClaudePlugin,
  ensureRuntime,
  expandHome,
  getConfigPath,
  makeCatalog,
  toShellExports,
  validateRuntime,
  writeConfig,
};
