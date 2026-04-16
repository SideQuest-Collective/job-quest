#!/bin/bash
# Job Quest Reinstall
# Cleanly removes the current installation and re-runs the bootstrap.
# Usage: bash ~/job-quest/reinstall.sh [--keep-data]
#
# Options:
#   --keep-data   Preserve user data (profile, intel, progress) across the reinstall

set -e

KEEP_DATA_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA_FLAG="--keep-data" ;;
  esac
done

HOME_DIR="$HOME"
APP_DIR="$HOME_DIR/job-quest"

echo ""
echo "  ⚔️  Job Quest — Reinstall"
echo "  ========================="
echo ""

# Save uninstall script to temp before we nuke the app dir
UNINSTALL_TMP=$(mktemp)
if [ -f "$APP_DIR/uninstall.sh" ]; then
  cp "$APP_DIR/uninstall.sh" "$UNINSTALL_TMP"
else
  echo "  Error: uninstall.sh not found at $APP_DIR/uninstall.sh"
  echo "  Run this script from an existing job-quest installation."
  rm -f "$UNINSTALL_TMP"
  exit 1
fi

echo "Step 1/2: Uninstalling current installation..."
echo ""
bash "$UNINSTALL_TMP" --yes $KEEP_DATA_FLAG
rm -f "$UNINSTALL_TMP"

echo ""
echo "Step 2/2: Installing fresh..."
echo ""
curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash

echo ""
echo "  Reinstall complete! Run /job-quest in Claude Code to get started."
echo ""
