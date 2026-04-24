#!/bin/bash
# Job Quest Updater

set -euo pipefail

CHECK_ONLY=false
IF_NEEDED=false
QUIET=false

for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=true ;;
    --if-needed) IF_NEEDED=true ;;
    --quiet) QUIET=true ;;
    *)
      echo "Usage: $0 [--check-only] [--if-needed] [--quiet]" >&2
      exit 1
      ;;
  esac
done

PRODUCT_HOME="${JOB_QUEST_PRODUCT_HOME:-$HOME/.job-quest}"
APP_DIR="${JOB_QUEST_APP_DIR:-$PRODUCT_HOME/app}"
REMOTE_NAME="${JOB_QUEST_UPDATE_REMOTE:-origin}"
REMOTE_BRANCH="${JOB_QUEST_UPDATE_BRANCH:-main}"

log() {
  if [ "$QUIET" = false ]; then
    echo "$@"
  fi
}

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required to update Job Quest." >&2
  exit 1
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "Error: Job Quest is not installed at $APP_DIR. Run install.sh first." >&2
  exit 1
fi

log ""
log "  Job Quest — Update Check"
log "  ========================"
log ""

if ! git -C "$APP_DIR" fetch --quiet "$REMOTE_NAME" "$REMOTE_BRANCH"; then
  echo "Error: could not fetch $REMOTE_NAME/$REMOTE_BRANCH." >&2
  exit 1
fi

LOCAL_HEAD="$(git -C "$APP_DIR" rev-parse HEAD)"
REMOTE_HEAD="$(git -C "$APP_DIR" rev-parse "$REMOTE_NAME/$REMOTE_BRANCH")"
BASE_HEAD="$(git -C "$APP_DIR" merge-base HEAD "$REMOTE_NAME/$REMOTE_BRANCH")"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  log "Job Quest is already up to date."
  exit 0
fi

if [ "$LOCAL_HEAD" != "$BASE_HEAD" ]; then
  if [ "$REMOTE_HEAD" = "$BASE_HEAD" ]; then
    log "Local installation is ahead of $REMOTE_NAME/$REMOTE_BRANCH; skipping automatic update."
  else
    log "Local installation has diverged from $REMOTE_NAME/$REMOTE_BRANCH; skipping automatic update."
  fi
  exit 0
fi

log "Update available: $LOCAL_HEAD -> $REMOTE_HEAD"

if [ "$CHECK_ONLY" = true ]; then
  exit 0
fi

if [ -n "$(git -C "$APP_DIR" status --porcelain)" ]; then
  echo "Error: local changes detected in $APP_DIR; automatic update skipped." >&2
  exit 1
fi

TMP_INSTALL="$(mktemp)"
trap 'rm -f "$TMP_INSTALL"' EXIT
git -C "$APP_DIR" show "$REMOTE_NAME/$REMOTE_BRANCH:install.sh" > "$TMP_INSTALL"

log "Applying update from $REMOTE_NAME/$REMOTE_BRANCH..."
bash "$TMP_INSTALL"

log "Job Quest update complete."
