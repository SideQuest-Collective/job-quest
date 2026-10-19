#!/bin/bash
# Install the daily Daily Drop podcast schedule (launchd on macOS, cron on Linux).
#   ~/.job-quest/bin/install-podcast-schedule.sh [HH:MM]   default 08:30, every day
#   --uninstall to remove, --show to print the current schedule
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/run-daily-podcast.sh"
LABEL="com.sidequest.job-quest.daily-podcast"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
MARKER="# job-quest-daily-podcast"
LOG_DIR="$HOME/.job-quest/data/logs"

is_macos() { [[ "$OSTYPE" == darwin* ]]; }

case "${1:-}" in
  --uninstall)
    if is_macos; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST" && echo "Removed $LABEL"
    else
      (crontab -l 2>/dev/null | grep -v "$MARKER") | crontab - && echo "Removed cron entry"
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
  (crontab -l 2>/dev/null | grep -v "$MARKER"; echo "$MIN $HOUR * * * /bin/bash $RUNNER $MARKER") | crontab -
  echo "Daily Drop scheduled every day at $(printf '%02d:%02d' "$HOUR" "$MIN") (cron)"
fi
