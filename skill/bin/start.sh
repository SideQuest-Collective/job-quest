#!/bin/bash
# Start the Job Quest web dashboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/../app/lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../app" && pwd)"
else
  echo "Error: could not locate Job Quest runtime helpers." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$REPO_ROOT/lib/runtime-shell.sh"
JOB_QUEST_REPO_ROOT="$REPO_ROOT"
job_quest_load_runtime --require-registration

DASHBOARD_DIR="$JOB_QUEST_APP_ROOT/app"

if [ ! -d "$DASHBOARD_DIR" ]; then
  echo "Error: Job Quest app not found at $DASHBOARD_DIR" >&2
  exit 1
fi

# Optional local adapter preserves explicitly configured hosting behavior.
export DATA_DIR="${DATA_DIR:-$JOB_QUEST_DATA_DIR}"
DASHBOARD_ENTRY="$(node - "$DATA_DIR" "$DASHBOARD_DIR/server.js" <<'NODE'
const fs = require('fs'), path = require('path');
try {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'local-setup.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entry = config.dashboardLauncher || process.argv[3];
  if (typeof entry !== 'string' || !path.isAbsolute(entry) || !/\.(c?js)$/.test(entry) || !fs.statSync(entry).isFile()) throw Error('Configured dashboard launcher is not a readable JavaScript file.');
  console.log(entry);
} catch (error) { console.error('Cannot start Job Quest: ' + error.message); process.exit(1); }
NODE
)"

if [ "${1:-}" = --background ]; then
  PORT="${JOB_QUEST_PORT:-${PORT:-3847}}"
  export PORT
  DATA_DIR="${DATA_DIR:-$JOB_QUEST_DATA_DIR}"
  LOG_FILE="$DATA_DIR/logs/dashboard.log"

  # Keep health-check, listener-check and spawn atomic across menu-bar clicks.
  mkdir -p "$DATA_DIR/logs"
  START_LOCK="$DATA_DIR/.start.lock"
  if ! mkdir "$START_LOCK" 2>/dev/null; then
    echo "Error: dashboard start is already in progress ($START_LOCK)." >&2
    exit 1
  fi
  trap 'rmdir "$START_LOCK" 2>/dev/null || true' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  dashboard_healthy() {
    curl -fsS --connect-timeout 1 --max-time 1 "http://localhost:$PORT/api/status" 2>/dev/null |
      node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { try { process.exit(JSON.parse(body).ok === true ? 0 : 1); } catch { process.exit(1); } });' >/dev/null 2>&1
  }

  if dashboard_healthy; then
    echo "Job Quest dashboard is already running at http://localhost:$PORT"
    exit 0
  fi
  if [ -n "$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]; then
    echo "Error: port $PORT is occupied but the dashboard is not healthy. See $LOG_FILE" >&2
    exit 1
  fi

  cd "$DASHBOARD_DIR"
  # A new process group survives the invoking agent/terminal session closing.
  node - "$DASHBOARD_ENTRY" "$LOG_FILE" <<'NODE'
const fs = require('fs'), { spawn } = require('child_process');
const log = fs.openSync(process.argv[3], 'a', 0o600);
const child = spawn(process.execPath, [process.argv[2]], {
  detached: true, stdio: ['ignore', log, log], env: process.env,
});
child.on('error', error => { console.error('Cannot start dashboard: ' + error.message); process.exitCode = 1; });
child.unref();
fs.closeSync(log);
NODE

  # One-second requests and a deadline bound even slow or unresponsive servers.
  deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if dashboard_healthy; then
      echo "Job Quest dashboard is running at http://localhost:$PORT"
      exit 0
    fi
    [ "$SECONDS" -ge "$deadline" ] || sleep 1
  done
  echo "Error: dashboard did not become healthy within 15 seconds. See $LOG_FILE" >&2
  exit 1
fi

echo ""
echo "  Starting Job Quest Command Center..."
echo "  Runtime:   $(job_quest_runtime_hint)"
echo "  Data:      $JOB_QUEST_DATA_DIR"
echo "  Dashboard: http://localhost:${PORT:-3847}"
echo ""

cd "$DASHBOARD_DIR"
node "$DASHBOARD_ENTRY"
