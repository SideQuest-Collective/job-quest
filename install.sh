#!/bin/bash
# Job Quest Installer
# Usage: curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash

set -e

echo ""
echo "  ⚔️  Job Quest — Personal Job Hunt Command Center"
echo "  ================================================"
echo ""

# Detect home directory
HOME_DIR="$HOME"
CLAUDE_DIR="$HOME_DIR/.claude"
SKILL_DIR="$CLAUDE_DIR/skills/job-quest"
DATA_DIR="$CLAUDE_DIR/job-quest"
APP_DIR="$HOME_DIR/job-quest"

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "  Node.js not found. Please install Node.js 18+ first:"
    echo "    macOS: brew install node"
    echo "    Linux: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "  Node.js $NODE_VERSION found but 18+ required. Please upgrade."
    exit 1
fi
echo "  Node.js $(node -v) OK"

if ! command -v git &> /dev/null; then
    echo "  git not found. Please install git first."
    exit 1
fi
echo "  git OK"

# Clone or update the app
echo ""
if [ -d "$APP_DIR" ]; then
    echo "Updating existing installation at $APP_DIR..."
    cd "$APP_DIR" && git pull
else
    echo "Cloning Job Quest to $APP_DIR..."
    git clone https://github.com/SideQuest-Collective/job-quest.git "$APP_DIR"
fi

# Install npm dependencies
echo "Installing dependencies..."
cd "$APP_DIR/app" && npm install --silent

# Configure data directory
echo "DATA_DIR=$DATA_DIR" > "$APP_DIR/app/.env"

# Install the Claude Code skill
echo ""
echo "Installing Claude Code skill..."
mkdir -p "$SKILL_DIR"
mkdir -p "$DATA_DIR/references"
mkdir -p "$DATA_DIR/bin"
cp "$APP_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
cp "$APP_DIR/skill/references/intel-agent-template.md" "$DATA_DIR/references/intel-agent-template.md"

# Install CLI scripts
cp "$APP_DIR/skill/bin/generate-plan.sh" "$DATA_DIR/bin/generate-plan.sh"
cp "$APP_DIR/skill/bin/code-review.sh" "$DATA_DIR/bin/code-review.sh"
cp "$APP_DIR/skill/bin/start.sh" "$DATA_DIR/bin/start.sh"
chmod +x "$DATA_DIR/bin/"*.sh
echo "  Scripts installed to $DATA_DIR/bin/"

# Initialize data directory
echo "Initializing data directory at $DATA_DIR..."
mkdir -p "$DATA_DIR"/{intel,quizzes,tasks,problems,behavioral,conversations,sd-conversations,resume-files}

# Seed empty JSON files if they don't exist
[ -f "$DATA_DIR/problems/problems.json" ] || echo '[]' > "$DATA_DIR/problems/problems.json"
[ -f "$DATA_DIR/problems/progress.json" ] || echo '{}' > "$DATA_DIR/problems/progress.json"
[ -f "$DATA_DIR/behavioral/answers.json" ] || echo '[]' > "$DATA_DIR/behavioral/answers.json"
[ -f "$DATA_DIR/role-tracker.json" ] || echo '{}' > "$DATA_DIR/role-tracker.json"
[ -f "$DATA_DIR/role-actions.json" ] || echo '{"saved":[],"skipped":[],"applied":[]}' > "$DATA_DIR/role-actions.json"
[ -f "$DATA_DIR/activity.json" ] || echo '[]' > "$DATA_DIR/activity.json"
[ -f "$DATA_DIR/progress.json" ] || echo '{}' > "$DATA_DIR/progress.json"
[ -f "$DATA_DIR/resume.json" ] || echo '{}' > "$DATA_DIR/resume.json"

echo ""
echo "  Installation complete!"
echo ""
echo "  Next steps:"
echo "    1. Open Claude Code"
echo "    2. Type /job-quest to start the onboarding"
echo "    3. Claude will interview you and set up your personalized daily intel agent"
echo ""
echo "  To start the web dashboard manually:"
echo "    ~/.claude/job-quest/bin/start.sh"
echo "    Then open http://localhost:3847"
echo ""
