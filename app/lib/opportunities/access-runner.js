'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ensureRuntime } = require('../../../lib/runtime');

const execute = promisify(execFile);
const MAX_TRACE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_EVIDENCE = 256;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeLabel(value) {
  return typeof value === 'string' && /^[\w:./-]{1,180}$/.test(value) ? value : null;
}

function privateResultText(result) {
  const value = typeof result === 'string' ? result : JSON.stringify(result);
  return Buffer.from(value || '', 'utf8').subarray(0, 8192).toString('utf8').replace(/\uFFFD$/, '');
}

function resultFailed(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.isError === true || result.is_error === true || result.error) return true;
  // Some MCP bridges wrap the structured response in a text block.
  return Array.isArray(result.content) && result.content.some(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return false;
    try {
      const parsed = JSON.parse(block.text);
      return Boolean(parsed && typeof parsed === 'object' &&
        (parsed.isError === true || parsed.is_error === true || parsed.error));
    } catch (_) { return false; }
  });
}

/** Result text is private evidence for the verifier. Never send it to clients or persist it. */
function parseAccessTrace(runtime, trace) {
  const evidence = new Map();
  const pending = new Map();
  let text = '';
  let protocolSeen = false;
  let failed = false;
  for (const line of String(trace || '').split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    if (!event || typeof event !== 'object') continue;
    if (runtime === 'codex') {
      if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      const item = event.item;
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
      if (item?.type !== 'mcp_tool_call' || !['item.started', 'item.updated', 'item.completed'].includes(event.type)) continue;
      protocolSeen = true;
      const id = safeLabel(item.id);
      const name = safeLabel(item.tool || item.name);
      if (!id || !name || evidence.size >= MAX_EVIDENCE && !evidence.has(id)) continue;
      const server = safeLabel(item.server);
      const ok = event.type === 'item.completed' && item.status === 'completed' &&
        item.result != null && !item.error && !resultFailed(item.result);
      evidence.set(id, { id, name: server ? `${server}/${name}` : name, ok, ...(ok ? { resultText: privateResultText(item.result) } : {}) });
    } else if (runtime === 'claude') {
      if (event.type === 'result') {
        if (typeof event.result === 'string') text = event.result;
        if (event.is_error === true || event.subtype && event.subtype !== 'success') failed = true;
      }
      const blocks = event.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (event.type === 'assistant' && block?.type === 'tool_use') {
          const id = safeLabel(block.id);
          const name = safeLabel(block.name);
          if (id && name && name.startsWith('mcp__') && pending.size < MAX_EVIDENCE) {
            protocolSeen = true;
            pending.set(id, name);
            evidence.set(id, { id, name, ok: false });
          }
        }
        if (event.type === 'user' && block?.type === 'tool_result') {
          const id = safeLabel(block.tool_use_id);
          if (!pending.has(id)) continue;
          const ok = block.content != null && !resultFailed(block);
          evidence.set(id, { id, name: pending.get(id), ok, ...(ok ? { resultText: privateResultText(block.content) } : {}) });
        }
      }
    }
  }
  return {
    text,
    toolEvidence: [...evidence.values()],
    traceSupported: protocolSeen,
    capabilityNote: protocolSeen ? null : 'This run did not expose supported account-tool call evidence; account access cannot be confirmed.',
    failed,
  };
}

function buildAccessInvocation(runtime, finalPath) {
  const id = runtime?.activeRuntime;
  const command = runtime?.runtimeCommand;
  const args = runtime?.runtimeCommandArgs;
  if (!['codex', 'claude'].includes(id) || typeof command !== 'string' ||
      /[\x00-\x1f\x7f]/.test(command) || path.basename(command) !== id ||
      !Array.isArray(args) || JSON.stringify(args) !== JSON.stringify(id === 'codex' ? ['exec'] : ['--print'])) {
    throw failure('ACCESS_RUNTIME_UNAVAILABLE', 'A directly installed, registered Codex or Claude runtime is required.');
  }
  if (runtime.runtimeValidation?.status === 'degraded') {
    throw failure('ACCESS_RUNTIME_UNAVAILABLE', 'The selected runtime is not ready. Check runtime diagnostics.');
  }
  if (id === 'codex') {
    return { command, args: [...args, '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--ephemeral', '--output-last-message', finalPath, '-'] };
  }
  return { command, args: [...args, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', '--no-session-persistence'] };
}

async function discoverCommand(runtime) {
  const helper = path.resolve(__dirname, '../../../lib/runtime-shell.sh');
  const script = 'source "$1"; job_quest_ensure_tool_path; job_quest_apply_runtime_env; printf "%s\\0" "$PATH" "${CODEX_HOME:-}" "$(command -v -- "$2" || :)"';
  let result;
  try {
    result = await execute('/bin/bash', ['--noprofile', '--norc', '-c', script, 'access-runner', helper, runtime.runtimeCommand], {
      env: { ...process.env, JOB_QUEST_ACTIVE_RUNTIME: runtime.activeRuntime },
      encoding: 'utf8', timeout: 5000, maxBuffer: 32768,
    });
  } catch (_) { throw failure('ACCESS_RUNTIME_UNAVAILABLE', 'The selected runtime executable could not be located.'); }
  const [toolPath, codexHome, command, extra] = result.stdout.split('\0');
  if (extra !== '' || !path.isAbsolute(command || '') || /[\x00-\x1f\x7f]/.test(command)) {
    throw failure('ACCESS_RUNTIME_UNAVAILABLE', 'The selected runtime executable could not be located.');
  }
  const env = { ...process.env, PATH: toolPath };
  if (codexHome) env.CODEX_HOME = codexHome;
  return { command, env };
}

function runProcess(command, args, { cwd, env, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    const stdout = [];
    let bytes = 0;
    let stopped = null;
    let timer;
    const stop = code => {
      if (stopped) return;
      stopped = code;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
    };
    try { child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (_) { reject(failure('ACCESS_RUNTIME_FAILED', 'The account check runtime could not be started.')); return; }
    timer = setTimeout(() => stop('ACCESS_TIMEOUT'), timeoutMs);
    const consume = (chunk, keep) => {
      bytes += chunk.length;
      if (bytes > MAX_TRACE_BYTES) { stop('ACCESS_OUTPUT_LIMIT'); return; }
      if (keep) stdout.push(chunk);
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.stdin.on('error', () => {});
    child.once('error', () => {
      clearTimeout(timer);
      reject(failure('ACCESS_RUNTIME_FAILED', 'The account check runtime could not be started.'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (stopped === 'ACCESS_TIMEOUT') reject(failure(stopped, 'The account check timed out. Try again after checking the runtime connection.'));
      else if (stopped) reject(failure(stopped, 'The account check exceeded its output limit.'));
      else if (code !== 0) reject(failure('ACCESS_RUNTIME_FAILED', 'The account check runtime failed. Check its sign-in and connected tools.'));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.end(prompt);
  });
}

async function runAccessAgent({ prompt, cwd, timeoutMs = 180000, getRuntime } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_TEXT_BYTES ||
      typeof cwd !== 'string' || !path.isAbsolute(cwd) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw failure('ACCESS_INVALID_REQUEST', 'The account check request is invalid.');
  }
  let runtime;
  try { runtime = await (getRuntime || (() => ensureRuntime({ write: false, allowSwitch: false, requireRegistration: true })))(); }
  catch (_) { throw failure('ACCESS_RUNTIME_UNAVAILABLE', 'The selected runtime could not be loaded. Check runtime diagnostics.'); }
  let directory;
  try { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jobquest-access-')); }
  catch (_) { throw failure('ACCESS_RUNTIME_FAILED', 'Private temporary storage for the account check is unavailable.'); }
  try {
    const finalPath = path.join(directory, 'last-message.txt');
    const invocation = buildAccessInvocation(runtime, finalPath);
    const resolved = await discoverCommand(runtime);
    const trace = await runProcess(resolved.command, invocation.args, { cwd, env: resolved.env, prompt, timeoutMs });
    const parsed = parseAccessTrace(runtime.activeRuntime, trace);
    if (parsed.failed) throw failure('ACCESS_RUNTIME_FAILED', 'The account check did not complete successfully. Check its sign-in and connected tools.');
    if (runtime.activeRuntime === 'codex') {
      try {
        const stat = await fs.stat(finalPath);
        if (stat.size > MAX_TEXT_BYTES) throw failure('ACCESS_OUTPUT_LIMIT', 'The account check exceeded its output limit.');
        parsed.text = await fs.readFile(finalPath, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!parsed.text.trim() || Buffer.byteLength(parsed.text) > MAX_TEXT_BYTES) {
      throw failure('ACCESS_RESPONSE_INVALID', 'The account check did not return a usable response.');
    }
    return { ...parsed, runtime: runtime.activeRuntime };
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('ACCESS_')) throw error;
    throw failure('ACCESS_RUNTIME_FAILED', 'The account check runtime could not complete.');
  } finally {
    try { await fs.rm(directory, { recursive: true, force: true }); }
    catch (_) { throw failure('ACCESS_CLEANUP_FAILED', 'Private temporary account check output could not be removed.'); }
  }
}

module.exports = { runAccessAgent, parseAccessTrace, buildAccessInvocation };
