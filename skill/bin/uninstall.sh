#!/bin/bash
# Job Quest Uninstaller

set -euo pipefail

KEEP_DATA=false
AUTO_YES=false

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=true ;;
    --yes) AUTO_YES=true ;;
  esac
done

HOME_DIR="$HOME"
PRODUCT_HOME="$HOME_DIR/.job-quest"
APP_DIR="$PRODUCT_HOME/app"
DATA_DIR="$PRODUCT_HOME/data"
BIN_DIR="$PRODUCT_HOME/bin"
CLAUDE_SKILL_DIR="$HOME_DIR/.claude/skills/job-quest"
CODEX_SKILL_DIR="$HOME_DIR/.codex/skills/job-quest"
LEGACY_HOME="$HOME_DIR/.claude/job-quest"

DATA_PATTERNS=(
  intel quizzes tasks problems behavioral conversations sd-conversations
  resume-files logs config runtime.json profile.json activity.json progress.json
  resume.json role-tracker.json role-actions.json applications.json
)

echo ""
echo "  Job Quest — Uninstaller"
echo "  ======================="
echo ""
echo "This will remove:"
echo "  Product home: $PRODUCT_HOME"
echo "  Claude skill: $CLAUDE_SKILL_DIR"
echo "  Codex skill:  $CODEX_SKILL_DIR"
echo "  Legacy shim:  $LEGACY_HOME"
echo "  Server:       process on port 3847 (if running)"
echo "  Schedule:     daily intel cron/launchd entry"
echo ""

if [ "$AUTO_YES" = false ]; then
  read -r -p "  Continue? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
  fi
  echo ""
fi

PID="$(lsof -ti :3847 2>/dev/null || true)"
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
fi

SCHEDULE_REMOVER="$BIN_DIR/install-schedule.sh"
if [ -x "$SCHEDULE_REMOVER" ]; then
  "$SCHEDULE_REMOVER" --uninstall || true
else
  PLIST="$HOME/Library/LaunchAgents/com.sidequest.job-quest.daily-intel.plist"
  [ -f "$PLIST" ] && launchctl unload "$PLIST" 2>/dev/null || true
  [ -f "$PLIST" ] && rm -f "$PLIST"
  if crontab -l 2>/dev/null | grep -q "# job-quest-daily-intel"; then
    crontab -l 2>/dev/null | grep -v "# job-quest-daily-intel" | crontab - 2>/dev/null || true
  fi
fi

rm -rf "$CLAUDE_SKILL_DIR" "$CODEX_SKILL_DIR"
if [ -L "$LEGACY_HOME" ]; then
  rm -f "$LEGACY_HOME"
elif [ -d "$LEGACY_HOME" ] && [ "$LEGACY_HOME" != "$PRODUCT_HOME" ]; then
  rm -rf "$LEGACY_HOME"
fi

for pattern in codelab_ interview_plan_ eval_ beh_ claude_prompt_ job_quest_prompt_ sd_interview_ resume_edit_; do
  rm -f "/tmp/${pattern}"* 2>/dev/null || true
done

if [ "$KEEP_DATA" = true ]; then
  if [ -d "$PRODUCT_HOME" ]; then
    STAGE="$(mktemp -d)"
    for pattern in "${DATA_PATTERNS[@]}"; do
      if [ -e "$PRODUCT_HOME/$pattern" ]; then
        mv "$PRODUCT_HOME/$pattern" "$STAGE/" 2>/dev/null || true
      fi
      if [ -e "$DATA_DIR/$pattern" ]; then
        mkdir -p "$STAGE/data"
        mv "$DATA_DIR/$pattern" "$STAGE/data/" 2>/dev/null || true
      fi
    done
    rm -rf "$PRODUCT_HOME"
    mkdir -p "$PRODUCT_HOME/data"
    if [ -d "$STAGE/data" ]; then
      mv "$STAGE/data"/* "$PRODUCT_HOME/data/" 2>/dev/null || true
    fi
    rm -rf "$STAGE"
  fi
else
  rm -rf "$PRODUCT_HOME"
fi

echo ""
echo "  Job Quest has been uninstalled."
if [ "$KEEP_DATA" = true ]; then
  echo "  Your data is preserved at $PRODUCT_HOME/data"
fi
echo ""
