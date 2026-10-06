// app/tests/fixtures/fake-agent.js (invoked as `node fake-agent.js …`, no shebang needed)
// Calls are recorded by appending one line per invocation to .fake/.calls.log
// (atomic for small appends), so concurrent agents never lose or wipe counts.
const fs = require('fs');
const path = require('path');

(async () => {
  const [agent, promptFile, cwd] = process.argv.slice(2);
  const prompt = fs.readFileSync(promptFile, 'utf-8');
  const fakeDir = path.join(cwd, '.fake');
  fs.mkdirSync(fakeDir, { recursive: true });
  const logFile = path.join(fakeDir, '.calls.log');
  fs.appendFileSync(logFile, `${agent}\t${process.pid}\n`);
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  const mine = lines.filter((l) => l.split('\t')[0] === agent);
  const attempt = mine.findIndex((l) => l === `${agent}\t${process.pid}`);
  const script = path.join(fakeDir, `${agent}.js`);
  if (!fs.existsSync(script)) process.exit(0);
  const fn = require(script);
  await fn({ agent, prompt, cwd, fs, path, attempt });
})().catch((err) => { process.stderr.write(String(err && err.message || err)); process.exit(1); });
