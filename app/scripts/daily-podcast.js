#!/usr/bin/env node
// Daily Drop CLI.
//   node daily-podcast.js run [--data-dir D] [--force] [--no-deliver] [--no-sheets] [--date YYYY-MM-DD]
//   node daily-podcast.js sheets [--data-dir D] [--limit N]     build missing per-role cheat sheets
//   node daily-podcast.js master [--data-dir D]                 rebuild the master cheat sheet
//   node daily-podcast.js fuzzy  [--data-dir D] --text "fuzzy BFS"   (used by the iMessage reply poller)
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args.shift() : 'run';
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const dataDir = path.resolve(opt('data-dir', process.env.DATA_DIR || path.join(os.homedir(), '.job-quest', 'data')));
const log = (m) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${m}`);

(async () => {
  const episode = require('../lib/podcast/episode');
  if (cmd === 'run') {
    const ep = await episode.generateEpisode({ dataDir, date: opt('date', undefined) || episode.localDate(), force: flag('force'), deliver: !flag('no-deliver'), buildSheets: !flag('no-sheets'), log });
    process.exit(ep.status === 'ready' ? 0 : 1);
  } else if (cmd === 'sheets') {
    const { missingSheets } = require('../lib/podcast/master');
    const { buildCheatsheet } = require('../lib/interview/cheatsheet');
    const todo = missingSheets(dataDir).slice(0, Number(opt('limit', 99)));
    log(`${todo.length} cheat sheets to build`);
    for (const r of todo) {
      log(`building ${r.roleKey}`);
      const res = await buildCheatsheet({ dataDir, roleId: r.workbookId, company: r.company, role: r.role, workbookId: r.workbookId });
      log(res.ok ? `  ${res.cards.length} cards` : `  failed: ${res.error}`);
    }
    await require('../lib/podcast/groups').buildGroups({ dataDir, cards: require('../lib/podcast/master').rawCards(dataDir).cards });
    episode.refreshMaster(dataDir);
  } else if (cmd === 'master') {
    if (!flag('no-group')) {
      const g = await require('../lib/podcast/groups').buildGroups({ dataDir, cards: require('../lib/podcast/master').rawCards(dataDir).cards });
      log(g.ok ? `concept groups ${g.cached ? 'cached' : `built (${g.groups})`}` : `grouping failed: ${g.error}`);
    }
    const m = episode.refreshMaster(dataDir);
    log(`${m.cards.length} cards from ${m.sources.length} roles; ${m.cards.filter((c) => c.shared).length} shared; ${m.missing.length} roles without a sheet`);
  } else if (cmd === 'fuzzy') {
    const r = require('../lib/podcast/fuzzy').fuzzyFromText(dataDir, opt('text', ''));
    console.log(r.message);
  } else {
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
