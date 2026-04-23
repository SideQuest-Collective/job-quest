#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PRODUCT_HOME = '~/.job-quest';
const LEGACY_HOME = '~/.claude/job-quest';
const DEFAULT_SCHEMA_VERSION = '1.0';
const SUPPORTED_RUNTIME_IDS = new Set(['claude', 'codex']);

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

function detectRuntime(env = process.env) {
  const explicit = (
    env.JOB_QUEST_RUNTIME ||
    env.JOBQUEST_RUNTIME ||
    env.JQ_RUNTIME ||
    ''
  ).toLowerCase();
  if (SUPPORTED_RUNTIME_IDS.has(explicit)) {
    return explicit;
  }
  if (
    env.CODEX_THREAD_ID ||
    env.CODEX_HOME ||
    env.CODEX_CI ||
    env.CODEX_SANDBOX
  ) {
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
    const registrationPath = path.join(
      expandHome(next.runtimeSkillDir),
      next.runtimeRegistrationFile,
    );
    if (!fs.existsSync(registrationPath)) {
      return {
        ok: false,
        config: next,
        reason: `Missing registration artifact at ${registrationPath}`,
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
  const targetRuntime = shouldSwitch ? detectedRuntime : config.activeRuntime;
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
  const runtimeRegistrationPath = path.join(
    expandHome(config.runtimeSkillDir),
    config.runtimeRegistrationFile,
  );
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
  console.error('Commands: ensure, shell, detect');
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

  printHelp();
  return 1;
}

if (require.main === module) {
  process.exit(cli(process.argv.slice(2)));
}

module.exports = {
  PRODUCT_HOME,
  LEGACY_HOME,
  compactHome,
  detectRuntime,
  ensureRuntime,
  expandHome,
  getConfigPath,
  makeCatalog,
  toShellExports,
  validateRuntime,
  writeConfig,
};
