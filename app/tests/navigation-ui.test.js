const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function navigation(page) {
  const context = {page, setupPage: page === 'setup' || page.startsWith('setup-'), intelPage: ['intel-roles','intel-outreach','intel-discover'].includes(page), taskCount: 3, quizCount: 5, newRoles: [], Icons: {}};
  vm.createContext(context);
  const start = source.indexOf('  const practiceTools =');
  const end = source.indexOf('\n  return (', start);
  vm.runInContext(source.slice(start,end) + '\nthis.result={navGroups,navItems,practiceTools,activeNav};', context);
  return context.result;
}
test('every former tool remains reachable while the main menu has seven destinations', () => {
  const nav = navigation('dashboard');
  assert.equal(nav.navItems.length,7);
  const reachable = new Set([...nav.navItems,...nav.practiceTools].map(item=>item.id));
  for(const route of ['dashboard','practice','learn','discover','dailydrop','tasks','quiz','intel-roles','resume','workbooks','calendar','codelab','sysdesign','behavioral','trainer','setup']) assert.ok(reachable.has(route),route);
  assert.equal(new Set(nav.navItems.map(item=>item.id)).size, nav.navItems.length);
  assert.ok(nav.navGroups.every(group=>group.label && group.items.length));
  assert.equal(nav.navGroups.at(-1).items.at(-1).id,'setup');
});
test('child routes keep the correct primary destination selected', () => {
  for(const route of navigation('practice').practiceTools.map(tool=>tool.id)) assert.equal(navigation(route).activeNav,'practice',route);
  for(const route of ['intel-roles','intel-outreach','intel-discover']) assert.equal(navigation(route).activeNav,'intel-roles');
  for(const route of ['setup','setup-access','setup-podcast','setup-accounts','setup-practice']) assert.equal(navigation(route).activeNav,'setup');
  assert.equal(navigation('discover').activeNav,'discover');
});
