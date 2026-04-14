#!/bin/bash
# Generate interview prep plan using Claude Code CLI
# Usage: ./scripts/generate-plan.sh <prompt-file>
# Reads prompt from a temp file, sends to Claude CLI, outputs JSON

set -euo pipefail

PROMPT_FILE="${1:-}"
LOG_DIR="$(dirname "$0")/../logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/plan-generation.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log "=== Plan generation started ==="

if [ -z "$PROMPT_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
  log "ERROR: No prompt file provided or file not found: $PROMPT_FILE"
  echo '{"error": true, "message": "No prompt file provided"}'
  exit 1
fi

log "Prompt file: $PROMPT_FILE ($(wc -c < "$PROMPT_FILE") bytes)"

# Load nvm
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  log "nvm loaded, node: $(node --version 2>/dev/null || echo 'not found')"
else
  log "WARNING: nvm not found at $NVM_DIR/nvm.sh"
fi

# Find Claude CLI
CLAUDE_CMD=""
if command -v claude &>/dev/null; then
  CLAUDE_CMD="claude"
  log "Using: claude ($(which claude))"
elif command -v npx &>/dev/null; then
  CLAUDE_CMD="npx -y @anthropic-ai/claude-code"
  log "Using: npx @anthropic-ai/claude-code ($(which npx))"
else
  log "ERROR: Neither claude nor npx found in PATH"
  echo '{"error": true, "message": "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"}'
  exit 1
fi

# Claude CLI flags for single-turn, fast generation
# Disallow all tools so Claude just generates text, and cap spend
CLAUDE_FLAGS="--print --disallowed-tools Bash,Edit,Read,Write,Glob,Grep,Agent"
log "Executing: cat prompt | $CLAUDE_CMD $CLAUDE_FLAGS"
START_TIME=$(date +%s)

STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)

if cat "$PROMPT_FILE" | $CLAUDE_CMD $CLAUDE_FLAGS > "$STDOUT_FILE" 2> "$STDERR_FILE"; then
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  STDOUT_SIZE=$(wc -c < "$STDOUT_FILE")
  log "SUCCESS: Claude responded in ${DURATION}s (${STDOUT_SIZE} bytes)"

  # Log first 200 chars of output for debugging
  log "Output preview: $(head -c 200 "$STDOUT_FILE" | tr '\n' ' ')"

  cat "$STDOUT_FILE"
else
  EXIT_CODE=$?
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  STDERR_CONTENT=$(cat "$STDERR_FILE" | head -c 500)
  log "FAILED: exit code $EXIT_CODE after ${DURATION}s"
  log "stderr: $STDERR_CONTENT"

  # Still output whatever we got — might be partial
  if [ -s "$STDOUT_FILE" ]; then
    log "Has partial stdout ($(wc -c < "$STDOUT_FILE") bytes), outputting"
    cat "$STDOUT_FILE"
  else
    echo ""
  fi
fi

# Cleanup temp files
rm -f "$STDOUT_FILE" "$STDERR_FILE"
log "=== Plan generation finished ==="
