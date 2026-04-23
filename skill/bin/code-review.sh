#!/bin/bash
# Generic conversational runtime wrapper used by code review, chat, and editing flows.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/../app/lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../app" && pwd)"
else
  echo "Error: Job Quest runtime helpers not found" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$REPO_ROOT/lib/runtime-shell.sh"
JOB_QUEST_REPO_ROOT="$REPO_ROOT"
job_quest_load_runtime --require-registration

if [ -n "${1:-}" ]; then
  PROMPT_FILE="$(mktemp)"
  printf '%s' "$1" > "$PROMPT_FILE"
  CLEANUP_PROMPT=1
else
  PROMPT_FILE="$(mktemp)"
  cat > "$PROMPT_FILE"
  CLEANUP_PROMPT=1
fi

if [ "$JOB_QUEST_ACTIVE_RUNTIME" = "codex" ]; then
  job_quest_run_prompt_file "$PROMPT_FILE" --sandbox workspace-write
else
  job_quest_run_prompt_file "$PROMPT_FILE"
fi
EXIT_CODE=$?

if [ "$CLEANUP_PROMPT" -eq 1 ]; then
  rm -f "$PROMPT_FILE"
fi

exit "$EXIT_CODE"
