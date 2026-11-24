#!/bin/bash
# Install the daily Daily Drop podcast schedule (launchd on macOS, cron on Linux).
#   ~/.job-quest/bin/install-podcast-schedule.sh [HH:MM]   default 08:30, every day
#   --uninstall to remove, --show to print the current schedule
#   --exists: exit 0 if installed, 1 if not, 2 if it could not tell (read-only)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/run-daily-podcast.sh"
LABEL="com.sidequest.job-quest.daily-podcast"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
MARKER="# job-quest-daily-podcast"
LOG_DIR="$HOME/.job-quest/data/logs"

is_macos() { [[ "$OSTYPE" == darwin* ]]; }

# The crontab is listed once per run, and any rewrite is built from that one listing,
# only when the listing succeeded. read_crontab keeps its output, error text and status.
CRONTAB_TEXT=""
CRONTAB_ERR=""
CRONTAB_STATUS=0
read_crontab() {
  local err_file
  CRONTAB_TEXT=""
  CRONTAB_STATUS=0
  if ! err_file="$(mktemp "${TMPDIR:-/tmp}/job-quest-crontab.XXXXXX")"; then
    CRONTAB_ERR="could not create a temporary file"
    CRONTAB_STATUS=1
    return 0
  fi
  CRONTAB_TEXT="$(crontab -l 2>"$err_file")" || CRONTAB_STATUS=$?
  CRONTAB_ERR="$(cat "$err_file" 2>/dev/null || true)"
  rm -f "$err_file"
}

# ok: the listing succeeded. none: the user has no crontab. error: anything else.
crontab_state() {
  if [ "$CRONTAB_STATUS" -eq 0 ]; then
    echo ok
  elif [[ "$CRONTAB_ERR" == *"no crontab for"* ]]; then
    echo none
  else
    echo error
  fi
}

crontab_has_marker() {
  [ -n "$CRONTAB_TEXT" ] && printf '%s\n' "$CRONTAB_TEXT" | grep -qF "$MARKER"
}

# The captured listing without this script's lines, one line per entry.
crontab_without_marker() {
  [ -n "$CRONTAB_TEXT" ] || return 0
  printf '%s\n' "$CRONTAB_TEXT" | grep -vF "$MARKER" || true
}

crontab_read_error() {
  echo "Error: could not read the crontab (${CRONTAB_ERR:-crontab -l exited $CRONTAB_STATUS}); it was left unchanged." >&2
}

case "${1:-}" in
  --exists)
    if is_macos; then
      [ -f "$PLIST" ] && exit 0
      exit 1
    fi
    read_crontab
    case "$(crontab_state)" in
      ok) crontab_has_marker && exit 0; exit 1 ;;
      none) exit 1 ;;
      *) exit 2 ;;
    esac ;;
  --uninstall)
    if is_macos; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST" && echo "Removed $LABEL"
    else
      read_crontab
      case "$(crontab_state)" in
        ok)
          if crontab_has_marker; then
            kept="$(crontab_without_marker)"
            if [ -n "$kept" ]; then
              printf '%s\n' "$kept" | crontab -
            else
              printf '' | crontab -
            fi
            echo "Removed cron entry"
          fi ;;
        none) ;;
        *) crontab_read_error; exit 1 ;;
      esac
    fi
    exit 0 ;;
  --show)
    if is_macos; then
      [ -f "$PLIST" ] && /usr/libexec/PlistBuddy -c "Print :StartCalendarInterval" "$PLIST" || echo "Not installed"
    else
      crontab -l 2>/dev/null | grep "$MARKER" || echo "Not installed"
    fi
    exit 0 ;;
esac

TIME="${1:-08:30}"
if ! [[ "$TIME" =~ ^([0-9]{1,2}):([0-9]{2})$ ]]; then echo "Time must look like 08:30" >&2; exit 1; fi
HOUR=$((10#${BASH_REMATCH[1]})); MIN=$((10#${BASH_REMATCH[2]}))
mkdir -p "$LOG_DIR"

if is_macos; then
  mkdir -p "$(dirname "$PLIST")"
  launchctl unload "$PLIST" 2>/dev/null || true
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${RUNNER}</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${HOUR}</integer><key>Minute</key><integer>${MIN}</integer></dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/daily-podcast.launchd.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/daily-podcast.launchd.err.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST
  launchctl load "$PLIST"
  echo "Daily Drop scheduled every day at $(printf '%02d:%02d' "$HOUR" "$MIN") ($PLIST)"
else
  read_crontab
  case "$(crontab_state)" in
    ok) kept="$(crontab_without_marker)" ;;
    none) kept="" ;;
    *) crontab_read_error; echo "Daily Drop was not scheduled." >&2; exit 1 ;;
  esac
  {
    if [ -n "$kept" ]; then printf '%s\n' "$kept"; fi
    echo "$MIN $HOUR * * * /bin/bash $RUNNER $MARKER"
  } | crontab -
  echo "Daily Drop scheduled every day at $(printf '%02d:%02d' "$HOUR" "$MIN") (cron)"
fi
