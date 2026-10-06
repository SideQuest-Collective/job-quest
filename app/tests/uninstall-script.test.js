const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UNINSTALL = path.resolve(__dirname, '../../skill/bin/uninstall.sh');

function exerciseStopLogic(t, releaseAfter = 1, finalListeners = '101 202 303') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-uninstall-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = fs.readFileSync(UNINSTALL, 'utf8');
  // Extract only the server-stop section: never run the uninstaller or its cleanup.
  const section = script.match(/\n(stop_dashboard_server\(\) \{[\s\S]*?)\nSCHEDULE_REMOVER=/);
  assert.ok(section, 'server-stop section must remain independently exercisable');
  const stubs = {
    lsof: `#!/bin/bash
printf '%s\\n' "$*" >> "$STOP_TEST_DIR/lsof.log"
count=0
[ ! -f "$STOP_TEST_DIR/count" ] || read -r count < "$STOP_TEST_DIR/count"
count=$((count + 1))
printf '%s\\n' "$count" > "$STOP_TEST_DIR/count"
if [ "$count" -gt "$RELEASE_AFTER" ]; then exit 1; fi
if [ "$count" -ge 7 ]; then
  printf '%s\\n' $FINAL_LISTENERS
else
  printf '%s\\n' 101 202 303
fi
case " $* " in
  *' -sTCP:LISTEN '*) ;;
  *) printf '%s\\n' 404 ;;
esac
`,
    ps: `#!/bin/bash
printf '%s\\n' "$*" >> "$STOP_TEST_DIR/ps.log"
case "$*" in
  '-o comm= -p 101') printf '%s\\n' /usr/local/bin/node ;;
  '-o comm= -p 202') printf '%s\\n' node ;;
  '-o comm= -p 303') printf '%s\\n' /usr/bin/python3 ;;
  '-o comm= -p 404') printf '%s\\n' node ;;
  *) exit 1 ;;
esac
`,
    sleep: `#!/bin/bash
printf '%s\\n' "$*" >> "$STOP_TEST_DIR/sleep.log"
`,
  };
  for (const [name, content] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
  }
  const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
kill() { printf '%s\\n' "$#:$*" >> "$STOP_TEST_DIR/kill.log"; }
${section[1]}
`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, STOP_TEST_DIR: dir, RELEASE_AFTER: String(releaseAfter), FINAL_LISTENERS: finalListeners },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = name => fs.existsSync(path.join(dir, `${name}.log`))
    ? fs.readFileSync(path.join(dir, `${name}.log`), 'utf8').trim().split('\n') : [];
  return { lines };
}

test('uninstall stops each node listener separately without killing clients or non-node listeners', t => {
  const { lines } = exerciseStopLogic(t);
  assert.deepEqual(lines('kill'), ['1:101', '1:202']);
  assert.ok(lines('lsof').every(args => args === '-nP -t -iTCP:3847 -sTCP:LISTEN'));
  assert.deepEqual(lines('ps'), ['-o comm= -p 101', '-o comm= -p 202', '-o comm= -p 303']);
});

test('uninstall waits for the listening port to become free and then stops polling', t => {
  const { lines } = exerciseStopLogic(t, 3);
  assert.equal(lines('lsof').length, 4);
  assert.deepEqual(lines('sleep'), ['1', '1']);
});

test('uninstall bounds its wait when the listening port stays occupied', t => {
  const { lines } = exerciseStopLogic(t, 99);
  assert.equal(lines('lsof').length, 7);
  assert.deepEqual(lines('sleep'), ['1', '1', '1', '1', '1']);
  assert.deepEqual(lines('kill'), ['1:101', '1:202', '2:-9 101', '2:-9 202']);
});

test('uninstall sends SIGKILL once only to node listeners still present after the bounded wait', t => {
  const { lines } = exerciseStopLogic(t, 99, '202 303');
  assert.deepEqual(lines('sleep'), ['1', '1', '1', '1', '1']);
  assert.deepEqual(lines('kill'), ['1:101', '1:202', '2:-9 202']);
  assert.deepEqual(lines('ps'), [
    '-o comm= -p 101', '-o comm= -p 202', '-o comm= -p 303',
    '-o comm= -p 202', '-o comm= -p 303',
  ]);
  assert.ok(lines('lsof').every(args => args === '-nP -t -iTCP:3847 -sTCP:LISTEN'));
});

test('uninstall skips SIGKILL when listeners exit during the last wait', t => {
  const { lines } = exerciseStopLogic(t, 6);
  assert.equal(lines('lsof').length, 7);
  assert.deepEqual(lines('sleep'), ['1', '1', '1', '1', '1']);
  assert.deepEqual(lines('kill'), ['1:101', '1:202']);
});

test('uninstall does not SIGKILL a new node listener that never received SIGTERM', t => {
  const { lines } = exerciseStopLogic(t, 99, '202 404');
  assert.deepEqual(lines('kill'), ['1:101', '1:202', '2:-9 202']);
});
