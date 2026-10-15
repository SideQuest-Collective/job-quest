#!/bin/bash
# Make today's Daily Drop podcast episode and text it over iMessage.
# Invoked by the launchd schedule from install-podcast-schedule.sh, or by hand:
#   ~/.job-quest/bin/run-daily-podcast.sh [--force] [--no-deliver]
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

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
# shellcheck disable=SC1090
source "$REPO_ROOT/lib/runtime-shell.sh"
JOB_QUEST_REPO_ROOT="$REPO_ROOT"
job_quest_load_runtime --require-registration

LOG_DIR="$JOB_QUEST_DATA_DIR/logs"
mkdir -p "$LOG_DIR"
export DATA_DIR="$JOB_QUEST_DATA_DIR"
node "$REPO_ROOT/app/scripts/daily-podcast.js" run --data-dir "$JOB_QUEST_DATA_DIR" "$@" 2>&1 | tee -a "$LOG_DIR/daily-podcast.log"
exit "${PIPESTATUS[0]}"
