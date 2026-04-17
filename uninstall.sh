#!/bin/bash
# Job Quest Uninstaller
# Usage: bash ~/job-quest/uninstall.sh [--keep-data] [--yes]
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
DATA_DIR="$CLAUDE_DIR/job-quest"
APP_DIR="$HOME_DIR/job-quest"

echo ""
echo "  ⚔️  Job Quest — Uninstaller"
echo "  ==========================="
echo ""

# Show what will be removed
echo "This will remove:"
echo "  App:       $APP_DIR"
echo "  Skill:     $SKILL_DIR"
if [ "$KEEP_DATA" = true ]; then
  echo "  Data:      $DATA_DIR (KEEPING — --keep-data)"
else
  echo "  Data:      $DATA_DIR"
fi
echo "  Server:    process on port 3847 (if running)"
echo "  Temp files: /tmp/codelab_* /tmp/interview_plan_* /tmp/eval_* /tmp/beh_* /tmp/claude_prompt_* /tmp/sd_interview_* /tmp/resume_edit_*"
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

# 1b. Remove the daily intel cron entry if installed
echo "Removing cron schedule..."
if crontab -l 2>/dev/null | grep -q "# job-quest-daily-intel"; then
  crontab -l 2>/dev/null | grep -v "# job-quest-daily-intel" | crontab -
  echo "  Removed job-quest cron entry"
else
  echo "  No cron entry to remove"
fi

# 2. Remove the Claude Code skill
echo "Removing skill..."
if [ -d "$SKILL_DIR" ]; then
  rm -rf "$SKILL_DIR"
  echo "  Removed $SKILL_DIR"
else
  echo "  Skill not found at $SKILL_DIR"
fi

# 3. Remove data directory (or keep it)
if [ "$KEEP_DATA" = true ]; then
  echo "Keeping user data at $DATA_DIR"
  # Still remove bin and references since those are app artifacts, not user data
  if [ -d "$DATA_DIR/bin" ]; then
    rm -rf "$DATA_DIR/bin"
    echo "  Removed $DATA_DIR/bin/"
  fi
  if [ -d "$DATA_DIR/references" ]; then
    rm -rf "$DATA_DIR/references"
    echo "  Removed $DATA_DIR/references/"
  fi
else
  echo "Removing data directory..."
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    echo "  Removed $DATA_DIR"
  else
    echo "  Data directory not found at $DATA_DIR"
  fi
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

# 5. Remove the app directory (do this last since this script lives there)
echo "Removing app..."
if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR"
  echo "  Removed $APP_DIR"
else
  echo "  App not found at $APP_DIR"
fi

echo ""
echo "  Job Quest has been uninstalled."
if [ "$KEEP_DATA" = true ]; then
  echo "  Your data is preserved at $DATA_DIR"
  echo "  To reinstall: curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash"
fi
echo ""
