#!/bin/bash
# Import a hand-built study kit (a folder containing content/*.md and content/glossary-*.txt)
# as a Job Quest workbook.
# Usage: import-workbook.sh <kit-dir> --roles "Company|Role" [--roles "Company|Role" ...] [--title "Title"] [--tier onsite|screen]
# Uses $DATA_DIR when set; otherwise the active runtime's Job Quest data directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/../app/lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../app" && pwd)"
else
  echo '{"error": "could not locate Job Quest runtime helpers"}'
  exit 1
fi

if [ -n "${DATA_DIR:-}" ]; then
  TARGET_DATA_DIR="$DATA_DIR"
else
  # shellcheck disable=SC1090
  source "$REPO_ROOT/lib/runtime-shell.sh"
  JOB_QUEST_REPO_ROOT="$REPO_ROOT"
  job_quest_load_runtime --require-registration
  TARGET_DATA_DIR="$JOB_QUEST_DATA_DIR"
fi

exec node "$REPO_ROOT/app/lib/workbook/import-cli.js" --data-dir "$TARGET_DATA_DIR" "$@"
