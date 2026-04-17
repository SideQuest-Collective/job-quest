#!/bin/bash
# Job Quest Reinstall
# Cleanly removes the current installation and re-runs the bootstrap.
# Usage: bash ~/.claude/job-quest/bin/reinstall.sh [--keep-data] [--yes]
#
# Options:
#   --keep-data   Preserve user data (profile, intel, progress) across the reinstall
#   --yes         Skip confirmation prompts in the uninstall step

set -e

EXTRA_FLAGS=""
for arg in "$@"; do
  case "$arg" in
    --keep-data) EXTRA_FLAGS="$EXTRA_FLAGS --keep-data" ;;
    --yes)       EXTRA_FLAGS="$EXTRA_FLAGS --yes" ;;
  esac
done

DATA_DIR="$HOME/.claude/job-quest"
UNINSTALL_SRC="$DATA_DIR/bin/uninstall.sh"

echo ""
echo "  ⚔️  Job Quest — Reinstall"
echo "  ========================="
echo ""

# Save uninstall script to temp — uninstall will delete ~/.claude/job-quest/bin/
UNINSTALL_TMP=$(mktemp)
if [ -f "$UNINSTALL_SRC" ]; then
  cp "$UNINSTALL_SRC" "$UNINSTALL_TMP"
# Fallback for legacy installs where the script still lives in the repo root
elif [ -f "$HOME/job-quest/uninstall.sh" ]; then
  cp "$HOME/job-quest/uninstall.sh" "$UNINSTALL_TMP"
else
  echo "  Error: uninstall.sh not found at $UNINSTALL_SRC"
  echo "  Run this script from an existing job-quest installation."
  rm -f "$UNINSTALL_TMP"
  exit 1
fi

echo "Step 1/2: Uninstalling current installation..."
echo ""
# Always pass --yes for the uninstall step inside reinstall — this is a scripted reset
bash "$UNINSTALL_TMP" --yes $EXTRA_FLAGS
rm -f "$UNINSTALL_TMP"

echo ""
echo "Step 2/2: Installing fresh..."
echo ""
curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash

echo ""
echo "  Reinstall complete! Run /job-quest in Claude Code to get started."
echo ""
