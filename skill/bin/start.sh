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

echo ""
echo "  Starting Job Quest Command Center..."
echo "  Runtime:   $(job_quest_runtime_hint)"
echo "  Data:      $JOB_QUEST_DATA_DIR"
echo "  Dashboard: http://localhost:${PORT:-3847}"
echo ""

cd "$DASHBOARD_DIR"
DATA_DIR="$JOB_QUEST_DATA_DIR" node server.js
