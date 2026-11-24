const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function helpers() {
  const block = html.match(/\/\* ===== SD TOPIC GROUPS ===== \*\/([\s\S]*?)\/\* ===== END SD TOPIC GROUPS ===== \*\//);
  assert.ok(block, 'index.html defines the SD TOPIC GROUPS block');
  return vm.runInThisContext(`(() => { ${block[1]}\nreturn { groupSdTopics, sdGroupKey }; })()`);
}

const topics = [
  { id: 'url-shortener', title: 'Design a URL Shortener', hasConversation: true },
  { id: 'news-feed', title: 'Design a News Feed', hasConversation: false },
  { id: 'wb-1', title: 'Design the RL env scheduler', source: 'workbook', sourceCompany: 'Mercor', sourceRole: 'Fullstack Engineer', sourceRoleKey: 'Mercor|Fullstack Engineer', hasConversation: false },
  { id: 'wb-2', title: 'Design payroll sync', source: 'workbook', sourceCompany: 'Rippling', sourceRole: 'Senior Software Engineer', sourceRoleKey: 'Rippling|Senior Software Engineer', hasConversation: true },
  { id: 'wb-3', title: 'Design grader fan-out', source: 'workbook', sourceCompany: 'Mercor', sourceRole: 'Fullstack Engineer', sourceRoleKey: 'Mercor|Fullstack Engineer', hasConversation: true },
  { id: 'wb-4', title: 'Design without a role key', source: 'workbook', sourceCompany: 'Sierra', sourceRole: 'Agent Engineer', hasConversation: false },
];

test('built-in topics form one general group and workbook topics group per role in first-seen order', () => {
  const { groupSdTopics } = helpers();
  const groups = groupSdTopics(topics);
  assert.deepStrictEqual(groups.map(g => g.key), ['general', 'Mercor|Fullstack Engineer', 'Rippling|Senior Software Engineer', 'Sierra|Agent Engineer']);
  assert.deepStrictEqual(groups.map(g => g.label), ['General practice', 'Mercor', 'Rippling', 'Sierra']);
  assert.deepStrictEqual(groups.map(g => g.sublabel), ['Classic system design problems', 'Fullstack Engineer', 'Senior Software Engineer', 'Agent Engineer']);
  assert.deepStrictEqual(groups.map(g => g.topics.map(t => t.id)), [['url-shortener', 'news-feed'], ['wb-1', 'wb-3'], ['wb-2'], ['wb-4']]);
});

test('each group counts its in-progress conversations', () => {
  const { groupSdTopics } = helpers();
  const groups = groupSdTopics(topics);
  assert.deepStrictEqual(groups.map(g => g.inProgress), [1, 1, 1, 0]);
});

test('sdGroupKey matches the key of the group a topic lands in', () => {
  const { groupSdTopics, sdGroupKey } = helpers();
  for (const group of groupSdTopics(topics)) {
    for (const topic of group.topics) assert.strictEqual(sdGroupKey(topic), group.key);
  }
});

test('an empty or missing list yields no groups', () => {
  const { groupSdTopics } = helpers();
  assert.deepStrictEqual(groupSdTopics([]), []);
  assert.deepStrictEqual(groupSdTopics(undefined), []);
});
