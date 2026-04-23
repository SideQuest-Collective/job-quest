#!/bin/bash
# Run the daily intel agent via the active runtime CLI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/../app/lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../app" && pwd)"
else
  echo "Error: could not locate Job Quest runtime helpers." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$REPO_ROOT/lib/runtime-shell.sh"
JOB_QUEST_REPO_ROOT="$REPO_ROOT"
job_quest_load_runtime --require-registration

PROFILE="$JOB_QUEST_DATA_DIR/profile.json"
TEMPLATE="$JOB_QUEST_REFERENCES_DIR/intel-agent-template.md"
LOG_DIR="$JOB_QUEST_DATA_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily-intel.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2
}

log "=== Daily intel run started ==="
log "Runtime: $(job_quest_runtime_hint)"

if [ ! -f "$PROFILE" ]; then
  log "ERROR: profile.json not found at $PROFILE. Open Job Quest in your runtime and complete onboarding first."
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  log "ERROR: intel-agent-template.md not found at $TEMPLATE"
  exit 1
fi

read_profile() {
  python3 -c "import json; d=json.load(open('$PROFILE')); print(d.get('$1',''))"
}

read_profile_list() {
  python3 -c "import json; d=json.load(open('$PROFILE')); v=d.get('$1',[]); print(', '.join(v) if isinstance(v, list) else v)"
}

NAME="$(read_profile name)"
TARGET_LEVEL="$(read_profile targetLevel)"
LOCATION="$(read_profile locationPrefs)"
STRENGTHS="$(read_profile_list strengths)"
CATEGORIES="$(python3 -c "import json; d=json.load(open('$PROFILE')); print(', '.join(d.get('targetCompanies',{}).get('categories',[])))")"
WEAK_SPOTS="$(read_profile_list interviewWeakSpots)"
TODAY="$(date +%Y-%m-%d)"

PROMPT_FILE="$(mktemp)"
cat > "$PROMPT_FILE" <<EOF
You are ${NAME}'s automated daily job hunt intelligence agent. Today is ${TODAY}. Your job is to write fresh content for the Job Quest Command Center at ${JOB_QUEST_DATA_DIR}.

## Profile
- Name: ${NAME}
- Target level: ${TARGET_LEVEL}
- Location: ${LOCATION}
- Strengths: ${STRENGTHS}
- Target company categories: ${CATEGORIES}
- Interview weak spots (bias prep toward these): ${WEAK_SPOTS}

## Deduplication
Read every JSON file in ${JOB_QUEST_DATA_DIR}/intel/ first. Each role is identified by "Company|Role Title". Never include a role that already appears in any prior intel file.

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
Read ${JOB_QUEST_DATA_DIR}/problems/progress.json to see what ${NAME} has solved. Generate problems calibrated to performance. APPEND to ${JOB_QUEST_DATA_DIR}/problems/problems.json — do not overwrite existing problems.

## Output files
- ${JOB_QUEST_DATA_DIR}/intel/${TODAY}.json
- ${JOB_QUEST_DATA_DIR}/quizzes/${TODAY}.json
- ${JOB_QUEST_DATA_DIR}/tasks/${TODAY}.json
- ${JOB_QUEST_DATA_DIR}/problems/problems.json

Each file's schema is documented in ${TEMPLATE}. Validate JSON before writing. When done, print a one-line summary: "Done: N roles, M quiz questions, K tasks, P new problems".
EOF

STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"

set +e
if [ "$JOB_QUEST_ACTIVE_RUNTIME" = "codex" ]; then
  job_quest_run_prompt_file "$PROMPT_FILE" --full-auto >"$STDOUT_FILE" 2>"$STDERR_FILE"
  EXIT_CODE=$?
else
  job_quest_run_prompt_file "$PROMPT_FILE" --allowed-tools Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash >"$STDOUT_FILE" 2>"$STDERR_FILE"
  EXIT_CODE=$?
fi
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  log "SUCCESS"
  log "Summary: $(tail -1 "$STDOUT_FILE")"
else
  log "FAILED: exit code $EXIT_CODE"
  log "stderr: $(head -c 400 "$STDERR_FILE" | tr '\n' ' ')"
fi

rm -f "$PROMPT_FILE" "$STDOUT_FILE" "$STDERR_FILE"
log "=== Daily intel run finished (exit $EXIT_CODE) ==="
exit "$EXIT_CODE"
