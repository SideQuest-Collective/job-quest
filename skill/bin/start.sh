#!/bin/bash
# Start the Job Quest web dashboard
# Usage: ~/.claude/job-quest/bin/start.sh

APP_DIR="$HOME/.claude/job-quest/app"
DATA_DIR="$HOME/.claude/job-quest"

if [ ! -d "$APP_DIR" ]; then
  echo "Error: Job Quest app not found at $APP_DIR"
  echo "Run the installer: curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash"
  exit 1
fi

echo ""
echo "  Starting Job Quest Command Center..."
echo "  Data: $DATA_DIR"
echo "  Dashboard: http://localhost:${PORT:-3847}"
echo ""

cd "$APP_DIR"
DATA_DIR="$DATA_DIR" node server.js
