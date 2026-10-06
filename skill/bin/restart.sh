#!/bin/bash
# Start performs the health check after the listener-scoped stop completes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/stop.sh"

# SIGKILL can return before the old listener has released its socket. Do not let
# start mistake the dying server for an already healthy replacement.
PORT="${JOB_QUEST_PORT:-${PORT:-3847}}"
for attempt in 1 2 3 4 5; do
  if [ -z "$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]; then
    exec "$SCRIPT_DIR/start.sh" --background
  fi
  sleep 1
done
echo "Error: port $PORT is still occupied after stopping the dashboard." >&2
exit 1
