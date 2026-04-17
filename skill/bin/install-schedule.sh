#!/bin/bash
# Install a local schedule (cron on Linux/macOS, optionally launchd on macOS)
# that runs the daily intel agent on the user's machine.
#
# Usage: ~/.claude/job-quest/bin/install-schedule.sh <cron-expression>
#   e.g. ~/.claude/job-quest/bin/install-schedule.sh "3 7 * * 1-5"
#
# Pass --uninstall to remove the schedule.
# Pass --show to print the current schedule.

set -euo pipefail

DATA_DIR="$HOME/.claude/job-quest"
RUNNER="$DATA_DIR/bin/run-daily-intel.sh"
MARKER="# job-quest-daily-intel"

# Helper: write a new crontab atomically, surfacing macOS Full Disk Access errors.
write_crontab() {
  local content="$1"
  local err
  err=$(printf '%s' "$content" | crontab - 2>&1) || {
    echo "Error updating crontab: $err" >&2
    if [[ "$err" == *"not permitted"* ]] && [[ "$OSTYPE" == darwin* ]]; then
      echo "" >&2
      echo "macOS blocks crontab modifications unless Terminal has Full Disk Access." >&2
      echo "Grant it: System Settings → Privacy & Security → Full Disk Access → enable your terminal app, then restart the terminal." >&2
      echo "Alternative: use launchd (native macOS scheduler) — see docs." >&2
    fi
    return 1
  }
}

# --show: print current schedule (doesn't require runner to exist)
if [ "${1:-}" = "--show" ]; then
  if crontab -l 2>/dev/null | grep -q "$MARKER"; then
    echo "Current schedule:"
    crontab -l 2>/dev/null | grep "$MARKER"
  else
    echo "No job-quest schedule installed."
  fi
  exit 0
fi

# --uninstall: remove any existing job-quest entries (doesn't require runner to exist)
if [ "${1:-}" = "--uninstall" ]; then
  if crontab -l 2>/dev/null | grep -q "$MARKER"; then
    CLEANED=$(crontab -l 2>/dev/null | grep -v "$MARKER")
    write_crontab "$CLEANED" && echo "Removed job-quest schedule from crontab."
  else
    echo "No job-quest schedule to remove."
  fi
  exit 0
fi

# For install, the runner must exist and be executable
if [ ! -x "$RUNNER" ]; then
  echo "Error: $RUNNER is missing or not executable. Run install.sh first." >&2
  exit 1
fi

CRON_EXPR="${1:-}"
if [ -z "$CRON_EXPR" ]; then
  echo "Usage: $0 <cron-expression>"
  echo "  e.g. $0 \"3 7 * * 1-5\"   # 7:03 AM weekdays"
  echo "       $0 \"3 7 * * *\"     # 7:03 AM daily"
  echo ""
  echo "Other commands:"
  echo "  $0 --show       Print current schedule"
  echo "  $0 --uninstall  Remove the schedule"
  exit 1
fi

# Validate cron expression has 5 fields
if [ "$(echo "$CRON_EXPR" | awk '{print NF}')" -ne 5 ]; then
  echo "Error: cron expression must have 5 fields (minute hour dom month dow)" >&2
  echo "Got: $CRON_EXPR" >&2
  exit 1
fi

# Remove any existing entry, then append the new one
NEW_ENTRY="$CRON_EXPR $RUNNER $MARKER"
EXISTING=$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)

if [ -n "$EXISTING" ]; then
  write_crontab "$(printf '%s\n%s' "$EXISTING" "$NEW_ENTRY")" || exit 1
else
  write_crontab "$NEW_ENTRY" || exit 1
fi

echo "Installed daily intel schedule:"
echo "  $NEW_ENTRY"
echo ""
echo "To view:      $0 --show"
echo "To remove:    $0 --uninstall"
echo "Logs:         $DATA_DIR/logs/daily-intel.log"
