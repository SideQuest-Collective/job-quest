#!/bin/bash
# Generate interview prep or evaluation output using the active runtime CLI

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/../app/lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../app" && pwd)"
else
  echo '{"error": true, "message": "Job Quest runtime helpers not found"}'
  exit 1
fi

# shellcheck disable=SC1090
source "$REPO_ROOT/lib/runtime-shell.sh"
JOB_QUEST_REPO_ROOT="$REPO_ROOT"
job_quest_load_runtime --require-registration

PROMPT_FILE="${1:-}"
LOG_DIR="$JOB_QUEST_DATA_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/plan-generation.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

if [ -z "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
  log "ERROR: missing prompt file: $PROMPT_FILE"
  echo '{"error": true, "message": "No prompt file provided"}'
  exit 1
fi

log "=== Plan generation started ==="
log "Runtime: $(job_quest_runtime_hint)"
log "Prompt file: $PROMPT_FILE ($(wc -c < "$PROMPT_FILE") bytes)"

STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"

if [ "$JOB_QUEST_ACTIVE_RUNTIME" = "codex" ]; then
  CMD=(job_quest_run_prompt_file "$PROMPT_FILE" --sandbox read-only)
else
  CMD=(job_quest_run_prompt_file "$PROMPT_FILE" --disallowed-tools Bash,Edit,Read,Write,Glob,Grep,Agent)
fi

set +e
"${CMD[@]}" >"$STDOUT_FILE" 2>"$STDERR_FILE"
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  log "SUCCESS: runtime responded ($(wc -c < "$STDOUT_FILE") bytes)"
  cat "$STDOUT_FILE"
else
  log "FAILED: exit code $EXIT_CODE"
  log "stderr: $(head -c 300 "$STDERR_FILE" | tr '\n' ' ')"
  if [ -s "$STDOUT_FILE" ]; then
    cat "$STDOUT_FILE"
  else
    echo "{\"error\": true, \"message\": \"$(job_quest_install_hint)\"}"
  fi
fi

rm -f "$STDOUT_FILE" "$STDERR_FILE"
log "=== Plan generation finished ==="
exit "$EXIT_CODE"
