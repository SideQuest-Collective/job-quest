#!/bin/bash
# Run the daily intel agent locally via Claude CLI
# Writes fresh intel, quiz, tasks, and coding problems to ~/.claude/job-quest/
# Designed to be invoked by cron/launchd on a schedule.
#
# Usage: ~/.claude/job-quest/bin/run-daily-intel.sh

set -euo pipefail

DATA_DIR="$HOME/.claude/job-quest"
PROFILE="$DATA_DIR/profile.json"
TEMPLATE="$DATA_DIR/references/intel-agent-template.md"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily-intel.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2
}

log "=== Daily intel run started ==="

# Verify prerequisites
if [ ! -f "$PROFILE" ]; then
  log "ERROR: profile.json not found at $PROFILE. Run /job-quest to complete onboarding first."
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  log "ERROR: intel-agent-template.md not found at $TEMPLATE"
  exit 1
fi

# Load nvm if present
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  log "nvm loaded, node: $(node --version 2>/dev/null || echo 'not found')"
fi

# Find Claude CLI
CLAUDE_CMD=""
if command -v claude &>/dev/null; then
  CLAUDE_CMD="claude"
elif command -v npx &>/dev/null; then
  CLAUDE_CMD="npx -y @anthropic-ai/claude-code"
else
  log "ERROR: Neither claude nor npx found in PATH. Install with: npm install -g @anthropic-ai/claude-code"
  exit 1
fi
log "Using Claude CLI: $CLAUDE_CMD"

# Extract profile fields using python (avoid jq dependency)
read_profile() {
  python3 -c "import json; d=json.load(open('$PROFILE')); print(d.get('$1',''))"
}
read_profile_list() {
  python3 -c "import json; d=json.load(open('$PROFILE')); v=d.get('$1',[]); print(', '.join(v) if isinstance(v, list) else v)"
}

NAME=$(read_profile name)
TARGET_LEVEL=$(read_profile targetLevel)
LOCATION=$(read_profile locationPrefs)
STRENGTHS=$(read_profile_list strengths)
CATEGORIES=$(python3 -c "import json; d=json.load(open('$PROFILE')); print(', '.join(d.get('targetCompanies',{}).get('categories',[])))")
WEAK_SPOTS=$(read_profile_list interviewWeakSpots)

TODAY=$(date +%Y-%m-%d)
log "Generating intel for $NAME ($TARGET_LEVEL, $LOCATION) for $TODAY"

# Build the personalized prompt
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" <<EOF
You are ${NAME}'s automated daily job hunt intelligence agent. Today is ${TODAY}. Your job is to write fresh content for the Job Quest Command Center at ${DATA_DIR}.

## Profile
- Name: ${NAME}
- Target level: ${TARGET_LEVEL}
- Location: ${LOCATION}
- Strengths: ${STRENGTHS}
- Target company categories: ${CATEGORIES}
- Interview weak spots (bias prep toward these): ${WEAK_SPOTS}

## Deduplication
Read every JSON file in ${DATA_DIR}/intel/ first. Each role is identified by "Company|Role Title". Never include a role that already appears in any prior intel file.

## Tasks

### 1. Discover 15-20 new roles
Search the web for ${TARGET_LEVEL} Software Engineer roles matching the target company categories above. Prioritize hybrid roles in ${LOCATION}. Capture: company, role title, level, location, URL, and a "fit" paragraph explaining why this matches ${NAME}'s background.

### 2. Find 8-10 interview tips
Search Blind, Reddit r/cscareerquestions, HackerNews, Glassdoor, levels.fyi. Focus on system design for ${TARGET_LEVEL} level, behavioral hacks, and negotiation tactics.

### 3. Create a 5-7 question quiz
Mix of 2-3 system design, 2 coding concept, 1-2 behavioral questions. Bias toward weak spots: ${WEAK_SPOTS}. Each question has exactly 4 options with a 0-indexed correctIndex and an explanation.

### 4. Create 8-10 daily tasks
Categories: coding, system-design, behavioral, research, networking, application. Each task MUST include a substantial \`content\` field (100-400 words for non-coding tasks) with a detailed markdown walkthrough that ${NAME} can read in the UI.

### 5. Append 3-5 adaptive coding problems
Read ${DATA_DIR}/problems/progress.json to see what ${NAME} has solved. Generate problems calibrated to performance. APPEND to ${DATA_DIR}/problems/problems.json — do not overwrite existing problems.

## Output files (use the Write tool)
- ${DATA_DIR}/intel/${TODAY}.json
- ${DATA_DIR}/quizzes/${TODAY}.json
- ${DATA_DIR}/tasks/${TODAY}.json
- ${DATA_DIR}/problems/problems.json (updated with appended problems)

Each file's schema is documented in ${TEMPLATE}. Validate JSON before writing. When done, print a one-line summary: "Done: N roles, M quiz questions, K tasks, P new problems".
EOF

log "Prompt built ($(wc -c < "$PROMPT_FILE") bytes)"

# Run Claude CLI with tools needed to read profile, search web, and write outputs
CLAUDE_FLAGS="--print --allowed-tools Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash"
log "Executing Claude agent (this may take 2-5 minutes)..."
START_TIME=$(date +%s)

STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)

if cat "$PROMPT_FILE" | $CLAUDE_CMD $CLAUDE_FLAGS > "$STDOUT_FILE" 2> "$STDERR_FILE"; then
  DURATION=$(($(date +%s) - START_TIME))
  log "SUCCESS in ${DURATION}s"
  log "Summary: $(tail -1 "$STDOUT_FILE")"
  EXIT_CODE=0
else
  EXIT_CODE=$?
  DURATION=$(($(date +%s) - START_TIME))
  log "FAILED: exit code $EXIT_CODE after ${DURATION}s"
  log "stderr: $(head -c 500 "$STDERR_FILE")"
fi

rm -f "$PROMPT_FILE" "$STDOUT_FILE" "$STDERR_FILE"
log "=== Daily intel run finished (exit $EXIT_CODE) ==="
exit $EXIT_CODE
