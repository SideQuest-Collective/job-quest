#!/bin/bash
# Install a local schedule for the daily intel agent.
#   macOS → uses launchd (~/Library/LaunchAgents/, no elevated permissions)
#   Linux → uses crontab
#
# Usage: ~/.job-quest/bin/install-schedule.sh <cron-expression>
#   e.g. ~/.job-quest/bin/install-schedule.sh "3 7 * * 1-5"
#
# Pass --uninstall to remove the schedule.
# Pass --show to print the current schedule.
# Pass --force-cron to opt into crontab on macOS (will prompt for Full Disk Access).

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

RUNNER="$JOB_QUEST_BIN_DIR/run-daily-intel.sh"
LOG_DIR="$JOB_QUEST_DATA_DIR/logs"
MARKER="# job-quest-daily-intel"
PLIST_LABEL="com.sidequest.job-quest.daily-intel"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

is_macos() { [[ "$OSTYPE" == darwin* ]]; }

# Parse cron expression (5 fields) and emit a launchd plist to stdout.
# Supported patterns for minute/hour: single integer.
# Supported patterns for day-of-week: '*' (daily), 'N' (single day), 'N-M' (range), 'N,M,...' (list).
# Day-of-month and month fields must be '*'.
generate_plist() {
  local cron="$1"
  python3 - "$cron" "$RUNNER" "$LOG_DIR" "$PLIST_LABEL" <<'PY'
import sys

cron, runner, log_dir, label = sys.argv[1:5]
parts = cron.split()
if len(parts) != 5:
    sys.exit("cron expression must have 5 fields")
minute, hour, dom, month, dow = parts

def as_int(s, field):
    try:
        return int(s)
    except ValueError:
        sys.exit(f"Unsupported {field} field: {s!r} (only single integers supported)")

m = as_int(minute, "minute")
h = as_int(hour, "hour")
if dom != "*" or month != "*":
    sys.exit("Day-of-month and month fields must be '*' for launchd scheduling")

# Expand day-of-week field to a list of ints (0=Sunday, 1=Mon, ..., 6=Sat).
def expand_dow(field):
    if field == "*":
        return None  # every day
    days = set()
    for chunk in field.split(","):
        if "-" in chunk:
            lo, hi = chunk.split("-", 1)
            days.update(range(as_int(lo, "dow"), as_int(hi, "dow") + 1))
        else:
            days.add(as_int(chunk, "dow"))
    return sorted(days)

dow_list = expand_dow(dow)

def entry(minute, hour, weekday=None):
    parts = [f"    <key>Minute</key><integer>{minute}</integer>",
             f"    <key>Hour</key><integer>{hour}</integer>"]
    if weekday is not None:
        parts.append(f"    <key>Weekday</key><integer>{weekday}</integer>")
    return "  <dict>\n" + "\n".join(parts) + "\n  </dict>"

if dow_list is None:
    calendar_items = [entry(m, h)]
else:
    calendar_items = [entry(m, h, d) for d in dow_list]

calendar_xml = "\n".join(calendar_items)

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
{calendar_xml}
  </array>
  <key>StandardOutPath</key>
  <string>{log_dir}/daily-intel.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>{log_dir}/daily-intel.launchd.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
"""
sys.stdout.write(plist)
PY
}

# Helper: write a new crontab atomically, surfacing macOS Full Disk Access errors.
write_crontab() {
  local content="$1"
  local err
  err=$(printf '%s' "$content" | crontab - 2>&1) || {
    echo "Error updating crontab: $err" >&2
    if [[ "$err" == *"not permitted"* ]] && is_macos; then
      echo "" >&2
      echo "macOS is blocking crontab modifications (Full Disk Access required)." >&2
      echo "Prefer using launchd instead — run this script without --force-cron." >&2
      printf "Open System Settings → Privacy & Security → Full Disk Access now? [y/N] " >&2
      read -r REPLY < /dev/tty || REPLY="n"
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
        echo "Enable your terminal app in the panel that just opened, restart the terminal, then re-run:" >&2
        echo "  $0 $* " >&2
      fi
    fi
    return 1
  }
}

install_launchd() {
  local cron="$1"
  mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIR"
  local plist
  plist=$(generate_plist "$cron") || exit 1

  # If already loaded, unload first so we can reload the new config.
  if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  printf '%s' "$plist" > "$PLIST_PATH"
  if ! launchctl load "$PLIST_PATH" 2>/dev/null; then
    echo "Error: launchctl load failed for $PLIST_PATH" >&2
    echo "Inspect the plist and try: launchctl load -w $PLIST_PATH" >&2
    return 1
  fi

  echo "Installed launchd agent:"
  echo "  Label: $PLIST_LABEL"
  echo "  Plist: $PLIST_PATH"
  echo "  Schedule (cron): $cron"
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
  if [ $removed -eq 1 ]; then
    echo "Removed launchd agent: $PLIST_LABEL"
  fi
  return 0
}

show_schedule() {
  local found=0
  if is_macos && [ -f "$PLIST_PATH" ]; then
    echo "launchd agent:"
    echo "  Label: $PLIST_LABEL"
    echo "  Plist: $PLIST_PATH"
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
  if [ $found -eq 0 ]; then
    echo "No job-quest schedule installed."
  fi
  return 0
}

# ---- arg parsing ----

FORCE_CRON=false
if [ "${1:-}" = "--force-cron" ]; then
  FORCE_CRON=true
  shift
fi

# --show: print current schedule
if [ "${1:-}" = "--show" ]; then
  show_schedule
  exit 0
fi

# --uninstall: remove both launchd and cron entries if present
if [ "${1:-}" = "--uninstall" ]; then
  removed=0
  if is_macos; then
    uninstall_launchd && removed=1
  fi
  if crontab -l 2>/dev/null | grep -q "$MARKER"; then
    CLEANED=$(crontab -l 2>/dev/null | grep -v "$MARKER")
    write_crontab "$CLEANED" && { echo "Removed job-quest entry from crontab."; removed=1; }
  fi
  [ $removed -eq 0 ] && echo "No job-quest schedule to remove."
  exit 0
fi

# For install, the runner must exist and be executable
if [ ! -x "$RUNNER" ]; then
  echo "Error: $RUNNER is missing or not executable. Run install.sh first." >&2
  exit 1
fi

CRON_EXPR="${1:-}"
if [ -z "$CRON_EXPR" ]; then
  echo "Usage: $0 [--force-cron] <cron-expression>"
  echo "  e.g. $0 \"3 7 * * 1-5\"   # 7:03 AM weekdays"
  echo "       $0 \"3 7 * * *\"     # 7:03 AM daily"
  echo ""
  echo "Other commands:"
  echo "  $0 --show       Print current schedule"
  echo "  $0 --uninstall  Remove the schedule"
  echo ""
  echo "On macOS, launchd is used by default (no elevated permissions needed)."
  echo "Pass --force-cron to use crontab on macOS (requires Full Disk Access)."
  exit 1
fi

# Validate cron expression has 5 fields
if [ "$(echo "$CRON_EXPR" | awk '{print NF}')" -ne 5 ]; then
  echo "Error: cron expression must have 5 fields (minute hour dom month dow)" >&2
  echo "Got: $CRON_EXPR" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

# macOS: use launchd by default (avoids Full Disk Access requirement)
if is_macos && [ "$FORCE_CRON" = false ]; then
  install_launchd "$CRON_EXPR" || exit 1
  # Clean up any old crontab entry from prior installs to avoid double-firing
  if crontab -l 2>/dev/null | grep -q "$MARKER"; then
    CLEANED=$(crontab -l 2>/dev/null | grep -v "$MARKER")
    write_crontab "$CLEANED" 2>/dev/null && echo "Cleaned up legacy crontab entry."
  fi
else
  # Linux, or --force-cron on macOS
  NEW_ENTRY="$CRON_EXPR $RUNNER $MARKER"
  EXISTING=$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)
  if [ -n "$EXISTING" ]; then
    write_crontab "$(printf '%s\n%s' "$EXISTING" "$NEW_ENTRY")" || exit 1
  else
    write_crontab "$NEW_ENTRY" || exit 1
  fi
  echo "Installed crontab entry:"
  echo "  $NEW_ENTRY"
fi

echo ""
echo "To view:    $0 --show"
echo "To remove:  $0 --uninstall"
echo "Logs:       $LOG_DIR/daily-intel.log"
