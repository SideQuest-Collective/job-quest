// app/lib/interview/prompts.js
const fs = require('fs');
const path = require('path');

const PROMPT_DIR = path.resolve(__dirname, '..', '..', '..', 'skill', 'references', 'interview');

function renderPrompt(name, vars) {
  const text = fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), 'utf-8');
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

module.exports = { PROMPT_DIR, renderPrompt };
