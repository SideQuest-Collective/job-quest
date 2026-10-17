// app/lib/podcast/store.js
// Paths, config and history for the Daily Drop podcast. All state lives under DATA_DIR/podcast.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = {
  enabled: true,
  model: 'gemini-3.8-flash-tts',
  hosts: [
    { name: 'Maya', voice: 'Kore', role: 'coach', style: 'warm, quick, a little playful' },
    { name: 'Dev', voice: 'Puck', role: 'skeptical interviewer', style: 'dry, sharp, curious' },
  ],
  targetMinutes: 15,
  hour: 8,
  minute: 30,
  sheetsPerRun: 3,
  topicsPerEpisode: 4,
  algorithmTopics: 2,
  imessage: true,
};

function podcastDir(dataDir) { return path.join(dataDir, 'podcast'); }
function episodesDir(dataDir) { return path.join(podcastDir(dataDir), 'episodes'); }
// An episode id is its date, or its date plus a slug for extra episodes made from a supplied script (2026-10-17-mercor-1).
const EPISODE_ID = /^\d{4}-\d{2}-\d{2}(-[a-z0-9][a-z0-9-]{0,39})?$/;
function episodeDir(dataDir, date) {
  if (!EPISODE_ID.test(String(date))) throw Object.assign(new Error('invalid episode id'), { status: 400 });
  return path.join(episodesDir(dataDir), date);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// The API key may live in env (GEMINI_API_KEY) or in ~/.job-quest/config/podcast-secrets.json (mode 600).
function secretsFile(dataDir) { return path.join(path.dirname(path.resolve(dataDir)), 'config', 'podcast-secrets.json'); }
function readApiKey(dataDir) {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  return readJson(secretsFile(dataDir), {}).geminiApiKey || '';
}
function writeApiKey(dataDir, key) {
  const file = secretsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ geminiApiKey: String(key || '').trim() }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// Whether the saved key has been proven to record audio. Tied to the key itself, so a new key starts unchecked.
function keyStatusFile(dataDir) { return path.join(podcastDir(dataDir), 'key-status.json'); }
function writeKeyStatus(dataDir, apiKey, status) {
  writeJson(keyStatusFile(dataDir), { ...status, keyHash: shortHash(apiKey) });
  return readKeyStatus(dataDir);
}
// Where the active key comes from: the environment wins over the secrets file.
function keySource(dataDir) {
  if (process.env.GEMINI_API_KEY) return 'env';
  return readJson(secretsFile(dataDir), {}).geminiApiKey ? 'file' : 'none';
}
function removeApiKey(dataDir) {
  fs.rmSync(secretsFile(dataDir), { force: true });
  fs.rmSync(keyStatusFile(dataDir), { force: true });
}
// The status never includes the key itself; `hint` is the last four characters so the person can tell keys apart.
function readKeyStatus(dataDir) {
  const apiKey = readApiKey(dataDir);
  if (!apiKey) {
    const { REMEDIATION } = require('./verify');
    return { verified: false, code: 'no-key', message: 'No Gemini API key is saved.', remediation: REMEDIATION['no-key'], source: 'none' };
  }
  const meta = { source: keySource(dataDir), hint: `…${apiKey.slice(-4)}` };
  const saved = readJson(keyStatusFile(dataDir), null);
  if (!saved || saved.keyHash !== shortHash(apiKey)) {
    return { verified: false, code: 'unchecked', message: 'This key has not been checked yet.', remediation: 'Check the key to make sure it can record audio.', ...meta };
  }
  const { keyHash, ...status } = saved;
  return { ...status, ...meta };
}

function readConfig(dataDir) {
  const saved = readJson(path.join(podcastDir(dataDir), 'config.json'), {});
  return { ...DEFAULT_CONFIG, ...saved, hosts: Array.isArray(saved.hosts) && saved.hosts.length === 2 ? saved.hosts : DEFAULT_CONFIG.hosts };
}
function writeConfig(dataDir, patch) {
  const allowed = ['enabled', 'targetMinutes', 'hour', 'minute', 'sheetsPerRun', 'topicsPerEpisode', 'algorithmTopics', 'imessage', 'hosts', 'model'];
  const next = { ...readConfig(dataDir) };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
  next.targetMinutes = Math.min(20, Math.max(5, Number(next.targetMinutes) || DEFAULT_CONFIG.targetMinutes));
  writeJson(path.join(podcastDir(dataDir), 'config.json'), next);
  return next;
}

function historyFile(dataDir) { return path.join(podcastDir(dataDir), 'history.json'); }
function readHistory(dataDir) { return readJson(historyFile(dataDir), {}); }
function recordAired(dataDir, ids, date) {
  const h = readHistory(dataDir);
  for (const id of ids) {
    const prev = h[id] || { airCount: 0 };
    h[id] = { airCount: prev.airCount + 1, lastAired: date, fuzzy: false };
  }
  writeJson(historyFile(dataDir), h);
}
// "fuzzy on X" feedback: the concept is pulled back into tomorrow's episode.
function markFuzzy(dataDir, id) {
  const h = readHistory(dataDir);
  h[id] = { ...(h[id] || { airCount: 0 }), fuzzy: true };
  writeJson(historyFile(dataDir), h);
}

function listEpisodes(dataDir) {
  const dir = episodesDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => EPISODE_ID.test(d)).sort().reverse()
    .map((id) => { const ep = readJson(path.join(dir, id, 'episode.json'), null); return ep && { ...ep, id: ep.id || id }; })
    .filter(Boolean);
}

// Onboarding: offered automatically once, always optional.
//   pending -> shown on next app load; later -> hidden for SNOOZE_DAYS; skipped / done -> never auto-shown.
const SNOOZE_DAYS = 3;
function onboardingFile(dataDir) { return path.join(podcastDir(dataDir), 'onboarding.json'); }
function readOnboarding(dataDir) { return readJson(onboardingFile(dataDir), { status: 'pending' }); }
function writeOnboarding(dataDir, action, now = new Date()) {
  const map = { later: 'later', skip: 'skipped', done: 'done', reset: 'pending' };
  if (!map[action]) throw Object.assign(new Error('action must be later, skip, done or reset'), { status: 400 });
  const next = { status: map[action], at: now.toISOString(), ...(action === 'later' ? { snoozeUntil: new Date(now.getTime() + SNOOZE_DAYS * 86400000).toISOString() } : {}) };
  writeJson(onboardingFile(dataDir), next);
  return next;
}
function shouldShowOnboarding(state, { configured, now = new Date() }) {
  if (configured) return false;
  if (state.status === 'pending') return true;
  if (state.status === 'later') return !state.snoozeUntil || new Date(state.snoozeUntil) <= now;
  return false;
}

const shortHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

module.exports = { EPISODE_ID,
  DEFAULT_CONFIG, podcastDir, episodesDir, episodeDir, readJson, writeJson,
  readApiKey, writeApiKey, removeApiKey, keySource, readKeyStatus, writeKeyStatus, readConfig, writeConfig, readHistory, recordAired, markFuzzy, listEpisodes, shortHash,
  SNOOZE_DAYS, readOnboarding, writeOnboarding, shouldShowOnboarding,
};
