#!/bin/bash
# Job Quest Reinstall

set -euo pipefail

EXTRA_FLAGS=()
for arg in "$@"; do
  case "$arg" in
    --keep-data|--yes)
      EXTRA_FLAGS+=("$arg")
      ;;
  esac
done

PRODUCT_HOME="$HOME/.job-quest"
UNINSTALL_SRC="$PRODUCT_HOME/bin/uninstall.sh"

echo ""
echo "  Job Quest — Reinstall"
echo "  ====================="
echo ""

UNINSTALL_TMP="$(mktemp)"
if [ ! -f "$UNINSTALL_SRC" ]; then
  echo "  Error: uninstall.sh not found at $UNINSTALL_SRC"
  exit 1
fi
cp "$UNINSTALL_SRC" "$UNINSTALL_TMP"

echo "Step 1/2: Uninstalling current installation..."
bash "$UNINSTALL_TMP" --yes "${EXTRA_FLAGS[@]}"
rm -f "$UNINSTALL_TMP"

echo ""
echo "Step 2/2: Installing fresh..."
curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash

echo ""
echo "  Reinstall complete."
echo ""
