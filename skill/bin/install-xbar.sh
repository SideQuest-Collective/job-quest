#!/bin/bash
# Job Quest — xbar plugin installer.
#
# Usage:
#   install-xbar.sh                # install plugin into xbar's plugin dir
#   install-xbar.sh --uninstall    # remove plugin
#   install-xbar.sh --status       # print install state
#
# xbar (https://xbarapp.com) is required and must be installed separately
# (e.g., `brew install --cask xbar`). This script copies the plugin into
# ~/Library/Application Support/xbar/plugins/ and triggers a refresh.

set -u

PRODUCT_HOME="$HOME/.job-quest"
BIN_DIR="$PRODUCT_HOME/bin"
SRC_PLUGIN_CANDIDATES=(
  "$BIN_DIR/xbar/job-quest.5m.sh"
  "$PRODUCT_HOME/app/skill/bin/xbar/job-quest.5m.sh"
)
PLUGIN_NAME="job-quest.5m.sh"
XBAR_PLUGIN_DIR="$HOME/Library/Application Support/xbar/plugins"
XBAR_APP="${XBAR_APP:-/Applications/xbar.app}"

action="${1:-install}"

find_source() {
  for p in "${SRC_PLUGIN_CANDIDATES[@]}"; do
    if [ -f "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}

require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "  This menu bar plugin is only supported on macOS (xbar)." >&2
    exit 1
  fi
}

xbar_installed() {
  [ -d "$XBAR_APP" ] || command -v xbar >/dev/null 2>&1
}

prompt_install_xbar() {
  cat <<'EOF'
  xbar isn't installed.

  Install it with Homebrew:

      brew install --cask xbar

  Or download from https://xbarapp.com — then rerun this command.
EOF
}

case "$action" in
  -h|--help|help)
    cat <<'EOF'
Job Quest xbar plugin installer.

Commands:
  install      (default) Copy plugin into xbar's plugin folder and refresh
  --uninstall  Remove plugin from xbar's plugin folder
  --status     Print install state
EOF
    ;;

  --status|status)
    require_macos
    if [ -f "$XBAR_PLUGIN_DIR/$PLUGIN_NAME" ]; then
      echo "installed: $XBAR_PLUGIN_DIR/$PLUGIN_NAME"
      exit 0
    else
      echo "not installed"
      exit 1
    fi
    ;;

  --uninstall|uninstall|remove)
    require_macos
    if [ -f "$XBAR_PLUGIN_DIR/$PLUGIN_NAME" ]; then
      rm -f "$XBAR_PLUGIN_DIR/$PLUGIN_NAME"
      echo "  Removed $XBAR_PLUGIN_DIR/$PLUGIN_NAME"
      if xbar_installed; then
        open -g "xbar://app.xbarapp.com/refreshAllPlugins" >/dev/null 2>&1 || true
      fi
    else
      echo "  Plugin not installed at $XBAR_PLUGIN_DIR/$PLUGIN_NAME"
    fi
    ;;

  install|"")
    require_macos
    if ! xbar_installed; then
      prompt_install_xbar
      exit 1
    fi
    SRC="$(find_source)" || {
      echo "  Could not locate job-quest.5m.sh. Try reinstalling Job Quest." >&2
      exit 1
    }
    mkdir -p "$XBAR_PLUGIN_DIR"
    cp "$SRC" "$XBAR_PLUGIN_DIR/$PLUGIN_NAME"
    chmod +x "$XBAR_PLUGIN_DIR/$PLUGIN_NAME"
    echo "  Installed $XBAR_PLUGIN_DIR/$PLUGIN_NAME"
    # Try to launch / refresh xbar
    if [ -d "$XBAR_APP" ]; then
      open -g -a "$XBAR_APP" >/dev/null 2>&1 || true
    fi
    open -g "xbar://app.xbarapp.com/refreshAllPlugins" >/dev/null 2>&1 || true
    cat <<EOF

  Look for "JQ" in your menu bar. If you don't see it:
    1. Open xbar (Cmd+Space, type "xbar")
    2. xbar menu → Plugin browser → Refresh all
EOF
    ;;

  *)
    echo "Unknown command: $action" >&2
    echo "Try: $(basename "$0") --help" >&2
    exit 2
    ;;
esac
