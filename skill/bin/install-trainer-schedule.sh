#!/bin/bash
# Install the hourly interview-trainer schedule.
#   macOS → launchd (~/Library/LaunchAgents/, no elevated permissions)
#   Linux → crontab
#
# Usage: ~/.job-quest/bin/install-trainer-schedule.sh [start-end]
#   e.g. ~/.job-quest/bin/install-trainer-schedule.sh 9-21   # top of every hour, 9am-9pm daily
#   Default hour range is 9-21.
#
# Pass --uninstall to remove the schedule.
# Pass --show to print the current schedule.
# Pass --exists to exit 0 if a schedule is installed.

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

RUNNER="$JOB_QUEST_BIN_DIR/run-interview-trainer.sh"
LOG_DIR="$JOB_QUEST_DATA_DIR/logs"
MARKER="# job-quest-interview-trainer"
PLIST_LABEL="com.sidequest.job-quest.interview-trainer"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

is_macos() { [[ "$OSTYPE" == darwin* ]]; }

current_range_from_launchd() {
  [ -f "$PLIST_PATH" ] || return 1
  python3 - "$PLIST_PATH" <<'PY'
import plistlib, sys

with open(sys.argv[1], "rb") as fh:
    data = plistlib.load(fh)

interval = data.get("StartCalendarInterval")
if not interval:
    sys.exit(1)
entries = interval if isinstance(interval, list) else [interval]
hours = sorted({int(e.get("Hour")) for e in entries})
if not hours:
    sys.exit(1)
print(f"{hours[0]}-{hours[-1]}")
PY
}

current_range_from_crontab() {
  local line
  line="$(crontab -l 2>/dev/null | grep "$MARKER" | head -n 1 || true)"
  [ -n "$line" ] || return 1
  echo "$line" | awk '{print $2}'
}

current_range() {
  if is_macos; then
    current_range_from_launchd && return 0
  fi
  current_range_from_crontab
}

generate_plist() {
  local range="$1"
  python3 - "$range" "$RUNNER" "$LOG_DIR" "$PLIST_LABEL" <<'PY'
import sys

hour_range, runner, log_dir, label = sys.argv[1:5]
try:
    lo, hi = (int(x) for x in hour_range.split("-", 1))
except ValueError:
    sys.exit(f"Hour range must look like 9-21, got: {hour_range!r}")
if not (0 <= lo <= hi <= 23):
    sys.exit(f"Hour range out of bounds: {hour_range}")

entries = "\n".join(
    "  <dict>\n"
    f"    <key>Minute</key><integer>0</integer>\n"
    f"    <key>Hour</key><integer>{h}</integer>\n"
    "  </dict>"
    for h in range(lo, hi + 1)
)

plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>{runner}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
{entries}
  </array>
  <key>StandardOutPath</key>
  <string>{log_dir}/interview-trainer.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>{log_dir}/interview-trainer.launchd.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
"""
sys.stdout.write(plist)
PY
}

install_launchd() {
  local range="$1"
  mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIR"
  local plist
  plist=$(generate_plist "$range") || exit 1

  if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  printf '%s' "$plist" > "$PLIST_PATH"
  if ! launchctl load "$PLIST_PATH" 2>/dev/null; then
    echo "Error: launchctl load failed for $PLIST_PATH" >&2
    return 1
  fi

  echo "Installed launchd agent:"
  echo "  Label: $PLIST_LABEL"
  echo "  Plist: $PLIST_PATH"
  echo "  Schedule: top of every hour, ${range%%-*}:00-${range##*-}:00, every day"
}

uninstall_launchd() {
  local removed=0
  if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    removed=1
  fi
  if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH"
    removed=1
  fi
  [ $removed -eq 1 ] && echo "Removed launchd agent: $PLIST_LABEL"
  return 0
}

show_schedule() {
  local found=0
  if is_macos && [ -f "$PLIST_PATH" ]; then
    echo "launchd agent:"
    echo "  Label: $PLIST_LABEL"
    echo "  Plist: $PLIST_PATH"
    echo "  Hours: $(current_range_from_launchd 2>/dev/null || echo unknown)"
    if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
      echo "  Status: loaded"
    else
      echo "  Status: not loaded"
    fi
    found=1
  fi
  if crontab -l 2>/dev/null | grep -q "$MARKER"; then
    echo "crontab entry:"
    crontab -l 2>/dev/null | grep "$MARKER"
    found=1
  fi
  [ $found -eq 0 ] && echo "No interview-trainer schedule installed."
  return 0
}

case "${1:-}" in
  --show) show_schedule; exit 0 ;;
  --exists) current_range >/dev/null 2>&1; exit $? ;;
  --current-range) current_range; exit $? ;;
  --uninstall)
    removed=0
    if is_macos; then
      uninstall_launchd && removed=1
    fi
    if crontab -l 2>/dev/null | grep -q "$MARKER"; then
      crontab -l 2>/dev/null | grep -v "$MARKER" | crontab - 2>/dev/null \
        && { echo "Removed interview-trainer entry from crontab."; removed=1; }
    fi
    [ $removed -eq 0 ] && echo "No interview-trainer schedule to remove."
    exit 0
    ;;
esac

if [ ! -x "$RUNNER" ]; then
  echo "Error: $RUNNER is missing or not executable. Run install.sh first." >&2
  exit 1
fi

RANGE="${1:-9-21}"
if ! [[ "$RANGE" =~ ^[0-9]{1,2}-[0-9]{1,2}$ ]]; then
  echo "Usage: $0 [start-end]        e.g. $0 9-21"
  echo "       $0 --show | --exists | --current-range | --uninstall"
  exit 1
fi

mkdir -p "$LOG_DIR"

if is_macos; then
  install_launchd "$RANGE" || exit 1
else
  NEW_ENTRY="0 $RANGE * * * $RUNNER $MARKER"
  EXISTING=$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)
  if [ -n "$EXISTING" ]; then
    printf '%s\n%s\n' "$EXISTING" "$NEW_ENTRY" | crontab -
  else
    printf '%s\n' "$NEW_ENTRY" | crontab -
  fi
  echo "Installed crontab entry:"
  echo "  $NEW_ENTRY"
fi

echo ""
echo "To view:    $0 --show"
echo "To remove:  $0 --uninstall"
echo "Logs:       $LOG_DIR/interview-trainer.log"
