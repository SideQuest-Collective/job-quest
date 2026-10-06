// app/tests/helpers/workbook-fixture.js
const fs = require('node:fs');
const path = require('node:path');

const CH1 = [
  '@@chapter id=intro company=acme topic="Company" title="Acme basics" mins=4 sub="Who they are"',
  '## In plain English',
  '',
  'Acme sells widgets.',
  '',
  '## Key takeaways',
  '',
  '- Widgets matter.',
  '',
  '@@q id=intro-1 company=acme topic="Company" type=mcq diff=1 chapter=intro',
  'What does Acme sell?',
  '@@choices',
  '- [x] Widgets',
  '- [ ] Gadgets',
  '- [ ] Gizmos',
  '@@answer',
  'Widgets.',
  '',
  '@@q id=intro-2 company=both topic="System design" type=open diff=3 chapter=intro',
  'Design a widget feed.',
  '@@hint',
  'Think about fan-out.',
  '@@rubric',
  '- Mentions fan-out on write.',
  '@@answer',
  'Fan out on write for small followings.',
  '',
].join('\n');

const CH2 = [
  '@@chapter id=algo company=both topic="Algorithms" title="Two pointers"',
  '## In plain English',
  '',
  'Two indexes walk one list.',
  '',
  '## Key takeaways',
  '',
  '- Sort first.',
  '',
  '@@q id=algo-1 company=both topic="Algorithms" type=code diff=2 chapter=algo',
  'Write `add_one(x)` that returns x + 1.',
  '@@rubric',
  '- Returns x + 1.',
  '@@tests',
  '```json',
  '{"entry": "add_one", "cases": [{"args": [1], "expect": 2}, {"args": [-1], "expect": 0}]}',
  '```',
  '@@answer',
  'Add one.',
  '',
  '```python',
  'def add_one(x):',
  '    return x + 1',
  '```',
  '',
].join('\n');

const GLOSS1 = ['# glossary for intro', 'widget :: A small thing.', '`Fan-out` :: Copying one write to many readers.', ''].join('\n');
const GLOSS2 = ['widget :: A small manufactured thing that does one job.', 'two pointers :: Two indexes moving through one list.', 'heap :: A tree kept in priority order.', ''].join('\n');

function writeKit(dir, extra = {}) {
  const content = path.join(dir, 'content');
  fs.mkdirSync(content, { recursive: true });
  const files = { '10-intro.md': CH1, '20-algo.md': CH2, 'glossary-10-intro.txt': GLOSS1, 'glossary-20-algo.txt': GLOSS2, ...extra };
  for (const [name, text] of Object.entries(files)) {
    if (text !== null) fs.writeFileSync(path.join(content, name), text);
  }
  return content;
}

module.exports = { writeKit, CH1, CH2, GLOSS1, GLOSS2 };
