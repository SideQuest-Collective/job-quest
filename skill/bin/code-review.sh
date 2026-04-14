#!/bin/bash
# Code review script using Claude CLI
# Usage: echo "prompt text" | ./scripts/code-review.sh
# Or:    ./scripts/code-review.sh "prompt text"

# Load nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Read prompt from argument or stdin
if [ -n "$1" ]; then
  PROMPT="$1"
else
  PROMPT=$(cat)
fi

if [ -z "$PROMPT" ]; then
  echo "Error: No prompt provided"
  exit 1
fi

# Try claude directly first, then npx fallback
if command -v claude &>/dev/null; then
  echo "$PROMPT" | claude --print
elif command -v npx &>/dev/null; then
  echo "$PROMPT" | npx -y @anthropic-ai/claude-code --print
else
  echo "Error: Neither 'claude' nor 'npx' found in PATH. Install Claude Code: npm install -g @anthropic-ai/claude-code"
  exit 1
fi
