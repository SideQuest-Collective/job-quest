// app/tests/interview-cheatsheet.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateCheatsheet, buildCheatsheet, cheatsheetWorkDir, CATEGORIES } = require('../lib/interview/cheatsheet');
const { renderPrompt } = require('../lib/interview/prompts');
const { makeEnv, seedWorkbook, withFakeAgent, fakeCalls } = require('./helpers/interview-env');

const ROLE_ID = 'acme-capital-software-engineer';
const card = (over = {}) => ({ title: 'Sweep line', category: 'algorithms', bullets: ['One.', 'Two.', 'Three.', 'Four.'], ...over });

function script(dir, source) {
  fs.mkdirSync(path.join(dir, '.fake'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.fake', 'interview-cheatsheet.js'), source);
}

test('categories are the /interview set plus warmup', () => {
  assert.deepEqual(CATEGORIES, ['warmup', 'intro', 'algorithms', 'probability', 'fundamentals', 'infra', 'design', 'critique']);
});

test('validateCheatsheet accepts a list or {cards} and trims', () => {
  const v1 = validateCheatsheet([card({ title: '  Padded  ', code: 'x = 1' })]);
  assert.equal(v1.ok, true);
  assert.deepEqual(v1.cards, [{ title: 'Padded', category: 'algorithms', bullets: ['One.', 'Two.', 'Three.', 'Four.'], code: 'x = 1' }]);
  assert.equal(validateCheatsheet({ cards: [card()] }).ok, true);
});

test('validateCheatsheet enforces categories, bullet count, length, card cap, and fields', () => {
  const errs = (d) => validateCheatsheet(d).errors.join('\n');
  assert.match(errs([card({ category: 'coding' })]), /card 1: category "coding" is not one of/);
  assert.match(errs([card({ bullets: ['a', 'b', 'c'] })]), /card 1: needs 4 to 6 bullets, has 3/);
  assert.match(errs([card({ bullets: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })]), /needs 4 to 6 bullets, has 7/);
  assert.match(errs([card({ bullets: ['x'.repeat(241), 'b', 'c', 'd'] })]), /card 1 bullet 1: 241 chars > 240/);
  assert.match(errs(Array.from({ length: 41 }, () => card())), /too many cards: 41 > 40/);
  assert.match(errs([card({ code: 7 })]), /card 1: code must be a string/);
  assert.match(errs([card({ extra: true })]), /card 1: unknown field extra/);
  assert.match(errs([card({ title: '' })]), /card 1: missing title/);
  assert.match(errs('nope'), /expected a JSON list of cards/);
  assert.match(errs([]), /no cards/);
  assert.deepEqual(validateCheatsheet([card({ category: 'coding' })]).cards, []);
});

test('renderPrompt fills known keys once and leaves unknown ones', () => {
  const p = renderPrompt('cheatsheet-agent', { company: 'Acme', role: 'SWE', categories: 'warmup', chapters: 'has {{company}} inside', errors: '' });
  assert.ok(p.includes('Acme — SWE'));
  assert.ok(p.includes('has {{company}} inside'));
});

test('validateCheatsheet accepts 15 code lines and rejects 16', () => {
  const code = Array(15).fill('x = 1').join('\n');
  assert.equal(validateCheatsheet([card({ code })]).ok, true);
  assert.deepEqual(validateCheatsheet([card({ code: `${code}\nx = 2` })]), {
    ok: false, errors: ['card 1: code has 16 lines > 15'], cards: [],
  });
});

for (const kind of ['traversal', 'absolute']) {
  test(`cheatsheetWorkDir rejects ${kind} roleIds`, (t) => {
    const { root, dataDir } = makeEnv();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const roleId = kind === 'traversal' ? '../../x' : path.join(root, 'outside');
    assert.throws(() => cheatsheetWorkDir(dataDir, roleId), /invalid roleId:/);
  });

  test(`buildCheatsheet rejects ${kind} roleIds before creating directories`, async (t) => {
    const { root, dataDir } = makeEnv();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const wb = seedWorkbook(dataDir);
    const roleId = kind === 'traversal' ? '../../x' : path.join(root, 'outside');
    const before = fs.readdirSync(root, { recursive: true });
    const result = await buildCheatsheet({ dataDir, roleId, workbookId: wb.id, noAgent: true });
    assert.deepEqual(fs.readdirSync(root, { recursive: true }), before);
    assert.equal(fs.existsSync(path.join(root, 'outside')), false);
    assert.deepEqual(result, { ok: false, error: `invalid roleId: ${roleId}` });
  });
}

for (const invalid of [{}, { cards: [card({ category: 'unknown' })] }]) {
  const label = invalid.cards ? 'unknown category' : 'missing cards';
  test(`buildCheatsheet rebuilds a current cache with ${label}`, async (t) => {
    withFakeAgent(t);
    const { root, dataDir } = makeEnv();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const wb = seedWorkbook(dataDir);
    const dir = cheatsheetWorkDir(dataDir, ROLE_ID);
    script(dir, fs.readFileSync(require('./helpers/interview-env').FAKE_CHEATSHEET, 'utf-8'));
    const args = { dataDir, roleId: ROLE_ID, workbookId: wb.id };
    const fresh = await buildCheatsheet(args);
    const cacheFile = path.join(dir, 'cheatsheet.json');
    const { sourceHash } = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    fs.writeFileSync(cacheFile, JSON.stringify({ sourceHash, ...invalid }));
    const result = await buildCheatsheet(args);
    assert.equal(fakeCalls(dir)['interview-cheatsheet'], 2);
    assert.deepEqual(result, fresh);
  });
}

test('buildCheatsheet never serves an invalid cache through noAgent or failed rebuild fallback', async (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wb = seedWorkbook(dataDir);
  const dir = cheatsheetWorkDir(dataDir, ROLE_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cheatsheet.json'), JSON.stringify({ sourceHash: 'old', cards: [card({ category: 'unknown' })] }));
  const args = { dataDir, roleId: ROLE_ID, workbookId: wb.id };
  assert.deepEqual(await buildCheatsheet({ ...args, noAgent: true }), { ok: false, error: 'cheatsheet-not-built' });
  let calls = 0;
  const result = await buildCheatsheet({ ...args, runAgentFn: async () => { calls++; return { ok: false, code: 1 }; } });
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: false, error: 'cheatsheet-invalid: the agent exited with code 1' });
});

test('buildCheatsheet normalizes cached cards for fresh hits and stale fallback', async (t) => {
  const { root, dataDir } = makeEnv();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wb = seedWorkbook(dataDir);
  const dir = cheatsheetWorkDir(dataDir, ROLE_ID);
  fs.mkdirSync(dir, { recursive: true });
  const sourceHash = require('../lib/interview/workbook-bridge').contentHash(dataDir, wb.id);
  fs.writeFileSync(path.join(dir, 'cheatsheet.json'), JSON.stringify({
    sourceHash, cards: [card({ title: '  Sweep line  ', bullets: [' One. ', ' Two. ', ' Three. ', ' Four. '] })],
  }));
  const args = { dataDir, roleId: ROLE_ID, workbookId: wb.id, noAgent: true };
  assert.deepEqual(await buildCheatsheet(args), { ok: true, cards: [card()], cached: true, stale: false });
  fs.appendFileSync(path.join(wb.dir, 'content', '01-coding-basics.md'), '\n');
  assert.deepEqual(await buildCheatsheet(args), { ok: true, cards: [card()], cached: true, stale: true, error: 'cheatsheet-not-built' });
});

test('buildCheatsheet retries once with the errors, then caches by workbook content hash', async (t) => {
  withFakeAgent(t);
  const { dataDir } = makeEnv();
  const wb = seedWorkbook(dataDir);
  const dir = cheatsheetWorkDir(dataDir, ROLE_ID);
  script(dir, `module.exports = async ({ cwd, fs, path, attempt, prompt }) => {
    fs.writeFileSync(path.join(cwd, 'prompt-' + attempt + '.txt'), prompt);
    const bullets = attempt === 0 ? ['a', 'b', 'c'] : ['One.', 'Two.', 'Three.', 'Four.'];
    fs.writeFileSync(path.join(cwd, 'cheatsheet.out.json'), JSON.stringify([{ title: 'Sweep line', category: 'algorithms', bullets }]));
  };`);
  const args = { dataDir, roleId: ROLE_ID, company: 'Acme Capital', role: 'Software Engineer', workbookId: wb.id };
  const r1 = await buildCheatsheet(args);
  assert.equal(r1.ok, true);
  assert.equal(r1.cached, false);
  assert.equal(r1.cards.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'prompt-0.txt'), 'utf-8'), /Coding basics/);
  assert.match(fs.readFileSync(path.join(dir, 'prompt-1.txt'), 'utf-8'), /needs 4 to 6 bullets, has 3/);
  const r2 = await buildCheatsheet(args);
  assert.equal(r2.cached, true);
  assert.equal(r2.stale, false);
  assert.equal(fakeCalls(dir)['interview-cheatsheet'], 2);
});

test('buildCheatsheet with noAgent and no cache reports cheatsheet-not-built and runs nothing', async (t) => {
  withFakeAgent(t);
  const { dataDir } = makeEnv();
  const wb = seedWorkbook(dataDir);
  const r = await buildCheatsheet({ dataDir, roleId: ROLE_ID, company: 'Acme Capital', role: 'Software Engineer', workbookId: wb.id, noAgent: true });
  assert.deepEqual(r, { ok: false, error: 'cheatsheet-not-built' });
  assert.deepEqual(fakeCalls(cheatsheetWorkDir(dataDir, ROLE_ID)), {});
});

test('buildCheatsheet falls back to the stale cache when a rebuild keeps failing', async (t) => {
  withFakeAgent(t);
  const { dataDir } = makeEnv();
  const wb = seedWorkbook(dataDir);
  const dir = cheatsheetWorkDir(dataDir, ROLE_ID);
  const args = { dataDir, roleId: ROLE_ID, company: 'Acme Capital', role: 'Software Engineer', workbookId: wb.id };
  script(dir, fs.readFileSync(require('./helpers/interview-env').FAKE_CHEATSHEET, 'utf-8'));
  assert.equal((await buildCheatsheet(args)).cached, false);
  fs.appendFileSync(path.join(wb.dir, 'content', '01-coding-basics.md'), '\n');
  script(dir, "module.exports = async () => { throw new Error('agent broke'); };");
  const r = await buildCheatsheet(args);
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.equal(r.cards.length, 2);
  assert.match(r.error, /cheatsheet-invalid/);
});
