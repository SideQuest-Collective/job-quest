'use strict';

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const TIMEOUT_MS = 4000;
const SCHEDULE_NOTE = 'Checks a minimal scheduler PATH; does not prove access from an actual scheduled job.';

function commandError(error) {
  if (error?.killed || error?.code === 'ETIMEDOUT') return 'Command timed out.';
  if (error?.code === 'ENOENT') return 'Executable was not found.';
  return 'Command could not be run.';
}

function versionText(stdout) {
  return String(stdout || '').split(/\r?\n/).map(line => line.trim()).find(line =>
    line.length <= 100 && /^(?:codex-cli\s+)?v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?:\s+\(Claude Code\))?$/.test(line)
  ) || null;
}

function executablePath(value) {
  if (!value) return null;
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid executable path');
  return value;
}

function createRuntimeDiagnostics({
  getRuntime,
  exec = execute,
  env = process.env,
  nodePath = process.execPath,
  nodeVersion = process.version,
  shellHelper = path.resolve(__dirname, '../../lib/runtime-shell.sh'),
} = {}) {
  async function run(file, args, contextEnv) {
    return exec(file, args, { env: contextEnv, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16384 });
  }

  async function version(file, contextEnv) {
    if (!file) return { path: null, version: null, ok: false, error: 'Executable was not found on PATH.' };
    try {
      const result = await run(file, ['--version'], contextEnv);
      const value = versionText(result.stdout);
      return { path: file, version: value, ok: Boolean(value), error: value ? null : 'Version command returned an unexpected response.' };
    } catch (error) {
      return { path: file, version: null, ok: false, error: commandError(error) };
    }
  }

  async function login(file, runtimeId, contextEnv) {
    if (runtimeId !== 'codex') return { status: 'not_checked', ready: null, error: 'Login status is only checked for Codex.' };
    if (!file) return { status: 'unknown', ready: null, error: 'Executable was not found on PATH.' };
    try {
      const result = await run(file, ['login', 'status'], contextEnv);
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (/not logged in/i.test(output)) return { status: 'not_logged_in', ready: false, error: null };
      if (/logged in using (?:ChatGPT|an API key)/i.test(output)) return { status: 'ready', ready: true, error: null };
      return { status: 'unknown', ready: null, error: 'Login status could not be confirmed.' };
    } catch (error) {
      // `login status` exits nonzero when signed out. Never return its raw output:
      // API-key login messages may include a credential prefix.
      if (/not logged in/i.test(`${error.stdout || ''}\n${error.stderr || ''}`)) {
        return { status: 'not_logged_in', ready: false, error: null };
      }
      return { status: 'unknown', ready: null, error: commandError(error) };
    }
  }

  async function runtimeDetails(file, runtime, contextEnv) {
    if (runtime.runtimeCommand === 'npx') {
      return {
        path: file || null, version: null, ok: false,
        error: 'Direct runtime CLI is unavailable; npx fallback was not executed.',
        login: { status: 'not_checked', ready: null, error: 'Login status was not checked for an npx fallback.' },
      };
    }
    const [details, auth] = await Promise.all([
      version(file, contextEnv),
      login(file, runtime.activeRuntime, contextEnv),
    ]);
    return { ...details, login: auth };
  }

  async function dashboard(runtime) {
    let file = null;
    let lookupError = null;
    try {
      const result = await run('/bin/bash', ['--noprofile', '--norc', '-c', 'command -v -- "$1" || :', 'runtime-diagnostics', runtime.runtimeCommand], env);
      file = executablePath(result.stdout.trim());
    } catch (error) { lookupError = commandError(error); }
    const details = await runtimeDetails(file, runtime, env);
    if (lookupError) details.error = lookupError;
    return {
      label: 'Dashboard process',
      node: { path: nodePath, version: nodeVersion, ok: true, error: null },
      runtime: details,
    };
  }

  async function scheduled(runtime) {
    const contextEnv = {
      ...env,
      HOME: env.JOB_QUEST_SYSTEM_HOME || env.HOME || os.homedir(),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      JOB_QUEST_ACTIVE_RUNTIME: runtime.activeRuntime,
    };
    try {
      const script = 'source "$1"; job_quest_ensure_tool_path; job_quest_apply_runtime_env; printf "%s\\0" "$PATH" "${CODEX_HOME:-}" "$(command -v node || :)" "$(command -v -- "$2" || :)"';
      const result = await run('/bin/bash', ['--noprofile', '--norc', '-c', script, 'runtime-diagnostics', shellHelper, runtime.runtimeCommand], contextEnv);
      const fields = result.stdout.split('\0');
      if (fields.length !== 5) throw new Error('Invalid shell response');
      const [toolPath, codexHome, node, file] = fields;
      executablePath(node);
      executablePath(file);
      const scheduledEnv = { ...contextEnv, PATH: toolPath };
      if (codexHome) scheduledEnv.CODEX_HOME = codexHome;
      const [nodeDetails, runtimeResult] = await Promise.all([
        version(node || null, scheduledEnv), runtimeDetails(file || null, runtime, scheduledEnv),
      ]);
      return { label: 'Scheduled PATH simulation', simulated: true, note: SCHEDULE_NOTE, node: nodeDetails, runtime: runtimeResult };
    } catch (error) {
      const details = { path: null, version: null, ok: false, error: commandError(error) };
      return {
        label: 'Scheduled PATH simulation', simulated: true, note: SCHEDULE_NOTE,
        node: { ...details },
        runtime: { ...details, login: { status: 'unknown', ready: null, error: 'Scheduled environment could not be checked.' } },
      };
    }
  }

  return async function diagnostics() {
    const runtime = getRuntime();
    const [dashboardResult, scheduledResult] = await Promise.all([dashboard(runtime), scheduled(runtime)]);
    return {
      runtime: { id: runtime.activeRuntime, displayName: runtime.runtimeDisplayName, command: runtime.runtimeCommand },
      dashboard: dashboardResult,
      scheduled: scheduledResult,
    };
  };
}

function registerRuntimeDiagnostics(app, options) {
  const diagnostics = createRuntimeDiagnostics(options);
  app.get('/api/runtime/diagnostics', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await diagnostics()); }
    catch (_) { res.status(500).json({ error: 'Runtime diagnostics could not be loaded.' }); }
  });
}

module.exports = { createRuntimeDiagnostics, registerRuntimeDiagnostics };
