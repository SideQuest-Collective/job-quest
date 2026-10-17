// app/lib/podcast/episode.js
// One Daily Drop run: top up cheat sheets -> master deck -> pick -> script -> audio -> deliver.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./store');
const { buildMaster, missingSheets, activeRoles, rawCards } = require('./master');
const { buildGroups } = require('./groups');
const { pickConcepts } = require('./picker');
const { writeScript } = require('./script');
const { renderEpisodeAudio } = require('./tts');
const { verifyApiKey } = require('./verify');
const topics = require('./topics');

// Prove the key can record audio before any cheat-sheet or script agent runs. A key that failed
// earlier is checked again here, so a billing fix takes effect on the next scheduled run by itself.
async function ensureVerifiedKey({ dataDir, config, fetchFn, log }) {
  let status = store.readKeyStatus(dataDir);
  if (status.verified) return status;
  const apiKey = store.readApiKey(dataDir);
  if (apiKey) {
    log('checking the Gemini key can record audio');
    status = store.writeKeyStatus(dataDir, apiKey, await verifyApiKey({ apiKey, model: config.model, hosts: config.hosts, ...(fetchFn ? { fetchFn } : {}) }));
    if (status.verified) return status;
  }
  throw Object.assign(new Error(`${status.message} ${status.remediation}`.trim()), { code: status.code });
}

function localDate(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

// Spaced retrieval across days: the most recent ready episode before this date supplies rules to recall first.
function previousTakeaways(dataDir, date) {
  const prev = store.listEpisodes(dataDir).find((e) => e.date < date && e.status === 'ready' && Array.isArray(e.takeaways) && e.takeaways.length);
  return prev ? prev.takeaways.slice(0, 3) : [];
}

function masterFile(dataDir) { return path.join(store.podcastDir(dataDir), 'master-cheatsheet.json'); }
function refreshMaster(dataDir) {
  const master = buildMaster(dataDir);
  store.writeJson(masterFile(dataDir), master);
  return master;
}
function readMaster(dataDir) { return store.readJson(masterFile(dataDir), null) || refreshMaster(dataDir); }

// Build a few missing per-role cheat sheets each run (each is a ~3 minute agent call).
async function topUpSheets(dataDir, limit, log) {
  const { buildCheatsheet } = require('../interview/cheatsheet');
  const todo = missingSheets(dataDir).slice(0, limit);
  for (const r of todo) {
    log(`building cheat sheet for ${r.roleKey}`);
    const res = await buildCheatsheet({ dataDir, roleId: r.workbookId, company: r.company, role: r.role, workbookId: r.workbookId });
    log(res.ok ? `  done: ${res.cards.length} cards` : `  failed: ${res.error}`);
  }
  return todo.length;
}

// Messages accepts a raw POSIX file sent to a buddy and reports success, but the file never reaches the phone.
// Coercing the file to an alias and sending it to the existing chat is what actually delivers it.
function imessageScript() {
  return `on run argv
  set targetHandle to item 1 of argv
  set theFile to (POSIX file (item 3 of argv)) as alias
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant targetHandle of targetService
    send (item 2 of argv) to targetBuddy
    delay 1
    try
      set targetChat to 1st chat whose participants contains targetBuddy
      send theFile to targetChat
    on error
      send theFile to targetBuddy
    end try
  end tell
  delay 3
end run`;
}

// A fresh name per send, so a regenerated episode is a new attachment rather than a duplicate of one Messages already saw.
function sharedAudioName(episode, filePath, now = new Date()) {
  const stamp = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `Daily Drop ${episode.date} ${stamp}${path.extname(filePath)}`;
}

function deliverIMessage(dataDir, episode, filePath, log) {
  if (process.platform !== 'darwin') { log('iMessage skipped (not macOS)'); return false; }
  const trainer = store.readJson(path.join(dataDir, 'trainer', 'config.json'), {});
  if (!trainer.phone) { log('iMessage skipped (no phone in trainer config)'); return false; }
  // Messages can only attach files from places it is allowed to read; ~/Pictures is the reliable one.
  const shareDir = path.join(os.homedir(), 'Pictures', 'Job Quest Daily Drop');
  fs.mkdirSync(shareDir, { recursive: true });
  const shared = path.join(shareDir, sharedAudioName(episode, filePath));
  fs.copyFileSync(filePath, shared);
  const text = `🎧 Daily Drop: ${episode.title}\n${episode.summary}\n${Math.round(episode.seconds / 60)} min. Text "fuzzy <topic>" to hear it again tomorrow.`;
  const r = spawnSync('osascript', ['-', trainer.phone, text, shared], { input: imessageScript(), encoding: 'utf8' });
  if (r.status === 0) { log(`iMessage sent to ${trainer.phone} with ${path.basename(shared)}`); return true; }
  log(`WARNING: iMessage failed: ${(r.stderr || '').slice(0, 300)}`);
  return false;
}

async function generateEpisode({ dataDir, date = localDate(), force = false, deliver = true, buildSheets = true, group = buildSheets, log = console.log, runAgentFn, fetchFn, readWorkbook }) {
  const config = store.readConfig(dataDir);
  const dir = store.episodeDir(dataDir, date);
  const epFile = path.join(dir, 'episode.json');
  const existing = store.readJson(epFile, null);
  if (existing && existing.status === 'ready' && !force) { log(`episode for ${date} already exists`); return existing; }
  fs.mkdirSync(dir, { recursive: true });
  const save = (patch) => { const ep = { ...(store.readJson(epFile, {})), ...patch, date, updatedAt: new Date().toISOString() }; store.writeJson(epFile, ep); return ep; };
  save({ status: 'building', step: 'cheat sheets', error: null });

  try {
    await ensureVerifiedKey({ dataDir, config, fetchFn, log });
    if (buildSheets && config.sheetsPerRun > 0) await topUpSheets(dataDir, config.sheetsPerRun, log);
    if (group) {
      const g = await buildGroups({ dataDir, cards: rawCards(dataDir).cards });
      log(g.ok ? `concept groups ${g.cached ? 'cached' : `built (${g.groups})`}` : `concept grouping failed, using word overlap: ${g.error}`);
    }
    const master = refreshMaster(dataDir);
    log(`master cheat sheet: ${master.cards.length} cards from ${master.sources.length} roles (${master.missing.length} roles still without a sheet)`);

    if (!readWorkbook) { try { readWorkbook = require('../interview/workbook-bridge').readWorkbook; } catch { readWorkbook = null; } }
    // What the upcoming interviews are likely to ask: rank the workbook topics, then make sure the top ones have a sheet.
    save({ step: 'ranking topics' });
    let ranking = readWorkbook ? topics.rankTopics(dataDir, { readWorkbook }) : { topics: [] };
    // Grouping is one cheap agent call that runs only when new topic names appear, so do it on every run.
    if (ranking.topics.length) {
      const g = await topics.buildTopicGroups({ dataDir, ranking, ...(runAgentFn ? { runAgentFn } : {}) });
      log(g.ok ? `topic groups ${g.cached ? 'cached' : `built (${g.groups})`}` : `topic grouping failed, using wording heuristics: ${g.error}`);
      if (g.ok && !g.cached) ranking = topics.rankTopics(dataDir, { readWorkbook });
    }
    log(`topics: ${ranking.topics.length} ranked`);
    if (buildSheets && config.sheetsPerRun > 0 && readWorkbook) await topics.topUpTopicSheets(dataDir, ranking, config.sheetsPerRun, log, { readWorkbook, ...(runAgentFn ? { runAgentFn } : {}) });
    const topicSheets = topics.readTopicSheets(dataDir, ranking);
    log(`topic sheets ready: ${topicSheets.length} of ${ranking.topics.length}`);

    save({ step: 'picking concepts' });
    const picked = pickConcepts({ dataDir, master, topics: topicSheets, today: date, readWorkbook, counts: { topics: config.topicsPerEpisode, algorithmTopics: config.algorithmTopics } });
    picked.recall = previousTakeaways(dataDir, date);
    if (!picked.all.length) throw new Error('Nothing to cover yet. Build at least one cheat sheet first.');
    log(`picked ${picked.topics.length} topics, ${picked.cards.length} cards, ${picked.review.length} review questions`);

    save({ step: 'writing script', concepts: picked.all.map((c) => ({ id: c.id, kind: c.kind, title: c.title || c.label || c.topic, companies: c.companies || [] })) });
    const upcoming = activeRoles(dataDir).filter((r) => ['onsite', 'phone-screen', 'offer'].includes(r.stage)).map((r) => `${r.company} (${r.stage})`);
    const s = await writeScript({ dataDir, workDir: dir, picked, config, upcoming, ...(runAgentFn ? { runAgentFn } : {}) });
    if (!s.ok) throw new Error(s.error);
    store.writeJson(path.join(dir, 'script.json'), s.script);
    save({ title: s.script.title, summary: s.script.summary, takeaways: s.script.takeaways, words: s.words, step: 'recording audio' });

    const audio = await renderEpisodeAudio({
      script: s.script, outDir: dir, apiKey: store.readApiKey(dataDir), model: config.model, hosts: config.hosts, fetchFn,
      onProgress: (i, n) => save({ step: `recording audio ${i + 1}/${n}` }),
    });
    store.recordAired(dataDir, picked.all.map((c) => c.id), date);
    let ep = save({ status: 'ready', step: null, audio: audio.file, seconds: audio.seconds });
    log(`episode ready: ${audio.file}, ${audio.seconds}s`);
    if (deliver && config.imessage) ep = save({ delivered: deliverIMessage(dataDir, ep, path.join(dir, audio.file), log) });
    return ep;
  } catch (e) {
    log(`ERROR: ${e.message}`);
    return save({ status: 'failed', error: e.message, errorCode: e.code || null });
  }
}

module.exports = { imessageScript, sharedAudioName, previousTakeaways, localDate, refreshMaster, readMaster, masterFile, generateEpisode, deliverIMessage };
