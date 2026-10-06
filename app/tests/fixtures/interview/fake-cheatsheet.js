// app/tests/fixtures/interview/fake-cheatsheet.js
// Scripted "interview-cheatsheet" agent for the fake runtime: two valid cards.
module.exports = async ({ cwd, fs, path }) => {
  const card = (title, category) => ({ title, category, bullets: ['Say the verdict first.', 'Name the key number.', 'Name the trap.', 'Ask one clarifying question.'] });
  fs.writeFileSync(path.join(cwd, 'cheatsheet.out.json'), JSON.stringify([card('Say first', 'warmup'), card('Sweep line', 'algorithms')]));
};
