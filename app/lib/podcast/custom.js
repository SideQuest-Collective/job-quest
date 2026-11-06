// app/lib/podcast/custom.js
// Render a podcast episode from a script file someone already wrote (by hand, or by Claude in a chat),
// skipping concept picking and the script agent. The episode lands next to the daily ones and plays in Daily Drop.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const { validateScript } = require('./script');
const { renderEpisodeAudio } = require('./tts');
const { localDate, deliverIMessage } = require('./episode');

const MAX_SCRIPT_BYTES = 1024 * 1024;
const WORDS_PER_MIN = 155;

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}

// Only JSON files under the user's home directory, so the local API can't be pointed at arbitrary system files.
function resolveScriptPath(scriptPath, { home = os.homedir() } = {}) {
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) throw Object.assign(new Error('scriptPath is required'), { status: 400 });
  const expanded = scriptPath.trim().replace(/^~(?=$|\/)/, home);
  if (!path.isAbsolute(expanded)) throw Object.assign(new Error('scriptPath must be absolute or start with ~/'), { status: 400 });
  const real = fs.existsSync(expanded) ? fs.realpathSync(expanded) : null;
  if (!real) throw Object.assign(new Error(`script not found: ${scriptPath}`), { status: 404 });
  const homeReal = fs.realpathSync(home);
  if (real !== homeReal && !real.startsWith(homeReal + path.sep)) throw Object.assign(new Error('scriptPath must be inside your home folder'), { status: 400 });
  if (path.extname(real).toLowerCase() !== '.json') throw Object.assign(new Error('scriptPath must be a .json file'), { status: 400 });
  if (fs.statSync(real).size > MAX_SCRIPT_BYTES) throw Object.assign(new Error('script file is larger than 1 MB'), { status: 400 });
  return real;
}

// Same rules as the daily script (two known hosts, question then pause, no em dashes), but the length comes from the script itself.
function checkScript(data, hosts) {
  const words = (data && Array.isArray(data.segments) ? data.segments : [])
    .filter((s) => s && s.type === 'line').reduce((n, s) => n + String(s.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
  const targetMinutes = Math.max(1, words / WORDS_PER_MIN);
  const v = validateScript(data, { hosts, targetMinutes, concepts: 0, minPauses: 0 });
  if (!v.ok) throw Object.assign(new Error(`script is invalid: ${v.errors.slice(0, 5).join('; ')}`), { status: 400, errors: v.errors });
  return v;
}

function episodeId(dataDir, { id, title, date }) {
  if (id) {
    const full = store.EPISODE_ID.test(id) ? id : `${date}-${slugify(id)}`;
    if (!store.EPISODE_ID.test(full) || full === date) throw Object.assign(new Error(`invalid id "${id}"`), { status: 400 });
    return full;
  }
  const base = `${date}-${slugify(title) || 'custom'}`.slice(0, 51).replace(/-+$/g, '');
  let candidate = base, n = 2;
  while (fs.existsSync(store.episodeDir(dataDir, candidate))) candidate = `${base.slice(0, 48)}-${n++}`;
  return candidate;
}

// Validate up front (cheap, synchronous) so a bad request fails before any paid audio is recorded.
function prepareCustomEpisode({ dataDir, scriptPath, id, home }) {
  const file = resolveScriptPath(scriptPath, { home });
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { throw Object.assign(new Error(`script is not valid JSON: ${e.message}`), { status: 400 }); }
  const config = store.readConfig(dataDir);
  const v = checkScript(data, config.hosts);
  const date = localDate();
  return { file, script: v.script, words: v.words, config, date, id: episodeId(dataDir, { id, title: v.script.title, date }) };
}

async function renderCustomEpisode({ dataDir, prepared, deliver = false, fetchFn, log = console.log }) {
  const { file, script, words, config, date, id } = prepared;
  const dir = store.episodeDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const epFile = path.join(dir, 'episode.json');
  const save = (patch) => { const ep = { ...(store.readJson(epFile, {})), ...patch, id, date, source: 'script', scriptPath: file, updatedAt: new Date().toISOString() }; store.writeJson(epFile, ep); return ep; };
  save({ status: 'building', step: 'recording audio', error: null, title: script.title, summary: script.summary, takeaways: script.takeaways, words });
  try {
    store.writeJson(path.join(dir, 'script.json'), script);
    const audio = await renderEpisodeAudio({
      script, outDir: dir, apiKey: store.readApiKey(dataDir), model: config.model, hosts: config.hosts, fetchFn,
      onProgress: (i, n) => save({ step: `recording audio ${i + 1}/${n}` }),
    });
    let ep = save({ status: 'ready', step: null, audio: audio.file, seconds: audio.seconds });
    log(`episode ${id} ready: ${audio.file}, ${audio.seconds}s`);
    if (deliver && config.imessage) ep = save({ delivered: deliverIMessage(dataDir, { ...ep, date: id }, path.join(dir, audio.file), log) });
    return ep;
  } catch (e) {
    log(`ERROR (${id}): ${e.message}`);
    return save({ status: 'failed', step: null, error: e.message, errorCode: e.code || null });
  }
}

module.exports = { slugify, resolveScriptPath, checkScript, episodeId, prepareCustomEpisode, renderCustomEpisode };
