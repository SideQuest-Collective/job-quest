#!/bin/bash
# Job Quest Installer
# Usage: curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash

set -euo pipefail

echo ""
echo "  Job Quest — Dual-Runtime Installer"
echo "  =================================="
echo ""

HOME_DIR="$HOME"
PRODUCT_HOME="$HOME_DIR/.job-quest"
APP_DIR="$PRODUCT_HOME/app"
DATA_DIR="$PRODUCT_HOME/data"
BIN_DIR="$PRODUCT_HOME/bin"
REFERENCES_DIR="$PRODUCT_HOME/references"
CONFIG_DIR="$PRODUCT_HOME/config"
LEGACY_HOME="$HOME_DIR/.claude/job-quest"
CLAUDE_SKILL_DIR="$HOME_DIR/.claude/skills/job-quest"
CODEX_SKILL_DIR="$HOME_DIR/.codex/skills/job-quest"

DATA_DIRS=(
  intel quizzes tasks problems behavioral conversations sd-conversations
  resume-files logs
)
DATA_FILES=(
  profile.json activity.json progress.json resume.json role-tracker.json
  role-actions.json applications.json
)

detect_runtime() {
  local explicit="${JOB_QUEST_RUNTIME:-${JOBQUEST_RUNTIME:-${JQ_RUNTIME:-}}}"
  explicit="$(printf '%s' "$explicit" | tr '[:upper:]' '[:lower:]')"
  case "$explicit" in
    claude|codex)
      echo "$explicit"
      return
      ;;
  esac

  if env | grep -q '^CODEX_'; then
    echo "codex"
  else
    echo "claude"
  fi
}

copy_if_missing() {
  local source="$1"
  local target="$2"
  if [ -e "$source" ] && [ ! -e "$target" ]; then
    mkdir -p "$(dirname "$target")"
    cp -R "$source" "$target"
  fi
}

link_compat_entry() {
  local name="$1"
  local target="$2"
  local shim="$PRODUCT_HOME/$name"
  if [ -L "$shim" ] || [ -e "$shim" ]; then
    return
  fi
  ln -s "$target" "$shim"
}

ACTIVE_RUNTIME="$(detect_runtime)"
echo "Detected runtime: $ACTIVE_RUNTIME"

echo ""
echo "Checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js not found. Please install Node.js 18+ first."
  exit 1
fi

NODE_VERSION="$(node -v | cut -d'v' -f2 | cut -d'.' -f1)"
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "  Node.js $NODE_VERSION found but 18+ required. Please upgrade."
  exit 1
fi
echo "  Node.js $(node -v) OK"

if ! command -v git >/dev/null 2>&1; then
  echo "  git not found. Please install git first."
  exit 1
fi
echo "  git OK"

echo ""
echo "Preparing shared product home at $PRODUCT_HOME..."
mkdir -p "$PRODUCT_HOME" "$DATA_DIR" "$BIN_DIR" "$REFERENCES_DIR" "$CONFIG_DIR"
for dir_name in "${DATA_DIRS[@]}"; do
  mkdir -p "$DATA_DIR/$dir_name"
done

echo ""
if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing installation at $APP_DIR..."
  cd "$APP_DIR" && git pull
elif [ -d "$APP_DIR" ]; then
  echo "Populating $APP_DIR with Job Quest source (preserving existing files)..."
  TMP_CLONE="$(mktemp -d)"
  git clone --quiet https://github.com/SideQuest-Collective/job-quest.git "$TMP_CLONE"
  (cd "$TMP_CLONE" && tar cf - .) | (cd "$APP_DIR" && tar xf -)
  rm -rf "$TMP_CLONE"
else
  echo "Cloning Job Quest to $APP_DIR..."
  mkdir -p "$(dirname "$APP_DIR")"
  git clone https://github.com/SideQuest-Collective/job-quest.git "$APP_DIR"
fi

echo ""
echo "Installing app dependencies..."
cd "$APP_DIR/app" && npm install --silent

echo "DATA_DIR=$DATA_DIR" > "$APP_DIR/app/.env"

echo ""
echo "Importing legacy Claude-root data if present..."
for dir_name in "${DATA_DIRS[@]}"; do
  copy_if_missing "$LEGACY_HOME/$dir_name" "$DATA_DIR/$dir_name"
done
for file_name in "${DATA_FILES[@]}"; do
  copy_if_missing "$LEGACY_HOME/$file_name" "$DATA_DIR/$file_name"
done

[ -f "$DATA_DIR/problems/problems.json" ] || echo '[]' > "$DATA_DIR/problems/problems.json"
[ -f "$DATA_DIR/problems/progress.json" ] || echo '{}' > "$DATA_DIR/problems/progress.json"
[ -f "$DATA_DIR/behavioral/answers.json" ] || echo '{}' > "$DATA_DIR/behavioral/answers.json"
[ -f "$DATA_DIR/role-tracker.json" ] || echo '{}' > "$DATA_DIR/role-tracker.json"
[ -f "$DATA_DIR/role-actions.json" ] || echo '{"saved":[],"skipped":[],"applied":[]}' > "$DATA_DIR/role-actions.json"
[ -f "$DATA_DIR/activity.json" ] || echo '{}' > "$DATA_DIR/activity.json"
[ -f "$DATA_DIR/progress.json" ] || echo '{}' > "$DATA_DIR/progress.json"
[ -f "$DATA_DIR/resume.json" ] || echo '{}' > "$DATA_DIR/resume.json"

echo ""
echo "Installing runtime-neutral helpers..."
cp "$APP_DIR/skill/bin/generate-plan.sh" "$BIN_DIR/generate-plan.sh"
cp "$APP_DIR/skill/bin/code-review.sh" "$BIN_DIR/code-review.sh"
cp "$APP_DIR/skill/bin/start.sh" "$BIN_DIR/start.sh"
cp "$APP_DIR/skill/bin/run-daily-intel.sh" "$BIN_DIR/run-daily-intel.sh"
cp "$APP_DIR/skill/bin/install-schedule.sh" "$BIN_DIR/install-schedule.sh"
cp "$APP_DIR/skill/bin/update.sh" "$BIN_DIR/update.sh"
cp "$APP_DIR/skill/bin/uninstall.sh" "$BIN_DIR/uninstall.sh"
cp "$APP_DIR/skill/bin/reinstall.sh" "$BIN_DIR/reinstall.sh"
chmod +x "$BIN_DIR/"*.sh

echo "Installing shared references..."
cp "$APP_DIR/skill/references/intel-agent-template.md" "$REFERENCES_DIR/intel-agent-template.md"

echo "Installing runtime registration artifacts..."
mkdir -p "$CLAUDE_SKILL_DIR" "$CODEX_SKILL_DIR"
cp "$APP_DIR/skill/SKILL.md" "$CLAUDE_SKILL_DIR/SKILL.md"
cp "$APP_DIR/skill/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md"

echo "Writing runtime descriptor..."
JOB_QUEST_RUNTIME="$ACTIVE_RUNTIME" node "$APP_DIR/lib/runtime.js" ensure --require-registration > /dev/null

echo "Creating compatibility shims..."
for dir_name in "${DATA_DIRS[@]}"; do
  link_compat_entry "$dir_name" "$DATA_DIR/$dir_name"
done
for file_name in "${DATA_FILES[@]}"; do
  link_compat_entry "$file_name" "$DATA_DIR/$file_name"
done
if [ ! -e "$LEGACY_HOME" ]; then
  mkdir -p "$(dirname "$LEGACY_HOME")"
  ln -s "$PRODUCT_HOME" "$LEGACY_HOME"
fi

echo ""
echo "  Installation complete!"
echo ""
echo "  Shared product home: $PRODUCT_HOME"
echo "  Active runtime:      $ACTIVE_RUNTIME"
echo "  Shared data:         $DATA_DIR"
echo ""
echo "  Registered entrypoints:"
echo "    Claude: ~/.claude/skills/job-quest/SKILL.md"
echo "    Codex:  ~/.codex/skills/job-quest/SKILL.md"
echo ""
echo "  Dashboard:"
echo "    ~/.job-quest/bin/start.sh"
echo "    Then open http://localhost:3847"
echo ""
