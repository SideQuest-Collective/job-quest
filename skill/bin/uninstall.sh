#!/bin/bash
# Job Quest Uninstaller
# Usage: bash ~/.claude/job-quest/bin/uninstall.sh [--keep-data] [--yes]
#
# Options:
#   --keep-data   Remove the app and skill but preserve user data (profile, intel, progress, etc.)
#   --yes         Skip confirmation prompts

set -e

KEEP_DATA=false
AUTO_YES=false

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=true ;;
    --yes) AUTO_YES=true ;;
  esac
done

HOME_DIR="$HOME"
CLAUDE_DIR="$HOME_DIR/.claude"
SKILL_DIR="$CLAUDE_DIR/skills/job-quest"
# App + data are consolidated under the same directory.
APP_DIR="$CLAUDE_DIR/job-quest"
DATA_DIR="$APP_DIR"

# Legacy install locations cleaned up here too so users who installed before
# the consolidation aren't left with orphaned directories.
LEGACY_APP_DIRS=("$HOME_DIR/job-quest" "$HOME_DIR/workspace/job-quest")

# Everything in APP_DIR except these patterns is considered "app artifacts"
# and is always removed. These patterns are preserved when --keep-data is set.
DATA_PATTERNS=(
  "intel" "quizzes" "tasks" "problems" "behavioral"
  "conversations" "sd-conversations" "resume-files" "logs"
  "profile.json" "activity.json" "progress.json" "resume.json"
  "role-tracker.json" "role-actions.json"
)

echo ""
echo "  ⚔️  Job Quest — Uninstaller"
echo "  ==========================="
echo ""

# Show what will be removed
echo "This will remove:"
echo "  Skill:       $SKILL_DIR"
if [ "$KEEP_DATA" = true ]; then
  echo "  Install:     $APP_DIR (app + scripts; KEEPING user data)"
else
  echo "  Install:     $APP_DIR (complete removal)"
fi
for LEGACY in "${LEGACY_APP_DIRS[@]}"; do
  [ -d "$LEGACY" ] && echo "  Legacy:      $LEGACY"
done
echo "  Server:      process on port 3847 (if running)"
echo "  Schedule:    daily intel cron/launchd entry"
echo "  Temp files:  /tmp/codelab_* /tmp/interview_plan_* /tmp/eval_* /tmp/beh_* /tmp/claude_prompt_* /tmp/sd_interview_* /tmp/resume_edit_*"
echo ""

if [ "$AUTO_YES" = false ]; then
  read -p "  Continue? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
  fi
  echo ""
fi

# 1. Stop the dashboard server if running
echo "Stopping dashboard server..."
PID=$(lsof -ti :3847 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null && echo "  Stopped server (PID $PID)" || echo "  Could not stop PID $PID"
else
  echo "  No server running on port 3847"
fi

# 2. Remove the daily intel schedule (launchd on macOS, cron on Linux)
echo "Removing daily intel schedule..."
SCHEDULE_REMOVER="$DATA_DIR/bin/install-schedule.sh"
if [ -x "$SCHEDULE_REMOVER" ]; then
  "$SCHEDULE_REMOVER" --uninstall || true
else
  # Fallback if the helper is already gone — clean up both mechanisms directly
  PLIST="$HOME/Library/LaunchAgents/com.sidequest.job-quest.daily-intel.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "  Removed launchd agent"
  fi
  if crontab -l 2>/dev/null | grep -q "# job-quest-daily-intel"; then
    crontab -l 2>/dev/null | grep -v "# job-quest-daily-intel" | crontab - 2>/dev/null || true
    echo "  Removed cron entry"
  fi
fi

# 3. Remove the Claude Code skill registration
echo "Removing skill..."
if [ -d "$SKILL_DIR" ]; then
  rm -rf "$SKILL_DIR"
  echo "  Removed $SKILL_DIR"
else
  echo "  Skill not found at $SKILL_DIR"
fi

# 4. Clean up temp files
echo "Cleaning temp files..."
TEMP_COUNT=0
for pattern in codelab_ interview_plan_ eval_ beh_ claude_prompt_ sd_interview_ resume_edit_; do
  found=$(find /tmp -maxdepth 1 -name "${pattern}*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$found" -gt 0 ]; then
    rm -f /tmp/${pattern}*
    TEMP_COUNT=$((TEMP_COUNT + found))
  fi
done
echo "  Cleaned $TEMP_COUNT temp files"

# 5. Remove legacy install directories if present
for LEGACY in "${LEGACY_APP_DIRS[@]}"; do
  if [ -d "$LEGACY" ] && [ "$LEGACY" != "$APP_DIR" ]; then
    rm -rf "$LEGACY"
    echo "Removed legacy install at $LEGACY"
  fi
done

# 6. Remove the main install — either fully or preserving user data
if [ "$KEEP_DATA" = true ]; then
  echo "Preserving user data at $APP_DIR (removing app + scripts)..."
  if [ -d "$APP_DIR" ]; then
    # Stage user data to a temp dir, wipe APP_DIR, restore user data.
    STAGE=$(mktemp -d)
    for pattern in "${DATA_PATTERNS[@]}"; do
      if [ -e "$APP_DIR/$pattern" ]; then
        mv "$APP_DIR/$pattern" "$STAGE/"
      fi
    done
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR"
    # Restore preserved entries
    if [ -n "$(ls -A "$STAGE" 2>/dev/null)" ]; then
      mv "$STAGE"/* "$APP_DIR/" 2>/dev/null || true
      mv "$STAGE"/.* "$APP_DIR/" 2>/dev/null || true
    fi
    rm -rf "$STAGE"
    echo "  Cleared app/scripts, kept user data at $APP_DIR"
  fi
else
  echo "Removing install directory..."
  if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
    echo "  Removed $APP_DIR"
  else
    echo "  Install not found at $APP_DIR"
  fi
fi

echo ""
echo "  Job Quest has been uninstalled."
if [ "$KEEP_DATA" = true ]; then
  echo "  Your data is preserved at $APP_DIR"
  echo "  To reinstall: curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash"
fi
echo ""
