#!/usr/bin/env node
// app/lib/workbook/import-cli.js — called by skill/bin/import-workbook.sh
const path = require('path');
const { importKit } = require('./import');

function parseArgs(argv) {
  const out = { roles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--roles') out.roles.push(value());
    else if (a === '--title') out.title = value();
    else if (a === '--tier') out.tier = value();
    else if (a === '--data-dir') out.dataDir = value();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!out.src) out.src = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  if (!a.src) throw new Error('usage: import-workbook.sh <kit-dir> --roles "Company|Role" [--roles ...] [--title T] [--tier onsite|screen]');
  if (!a.roles.length) throw new Error('at least one --roles "Company|Role" is required');
  if (!a.dataDir) throw new Error('--data-dir is required');
  const report = await importKit({ dataDir: path.resolve(a.dataDir), srcDir: path.resolve(a.src), roleKeys: a.roles, title: a.title, tier: a.tier || 'onsite' });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch((err) => {
  process.stdout.write(`${JSON.stringify({ error: String((err && err.message) || err) })}\n`);
  process.exit(1);
});
