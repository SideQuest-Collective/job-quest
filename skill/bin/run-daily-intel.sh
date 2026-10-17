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

# A manual run and the native schedule share one lock: no concurrent data writers.
RUN_LOCK="$LOG_DIR/.daily-intel.lock"
RUN_LOCK_HELPER="$JOB_QUEST_APP_ROOT/app/lib/intel-control/lock.js"
RUN_LOCK_TOKEN="$(node "$RUN_LOCK_HELPER" acquire "$RUN_LOCK" "$$")" || exit 73
release_run_lock() {
  node "$RUN_LOCK_HELPER" release "$RUN_LOCK" "$$" "$RUN_LOCK_TOKEN" 2>/dev/null || true
}
trap release_run_lock EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2
}

log "=== Daily intel run started ==="
log "Runtime: $(job_quest_runtime_hint)"
log "Runtime command: ${JOB_QUEST_RUNTIME_COMMAND:-unknown} ${JOB_QUEST_RUNTIME_COMMAND_ARGS[*]:-}"
log "App root: ${JOB_QUEST_APP_ROOT:-unset}"
log "Data dir: ${JOB_QUEST_DATA_DIR:-unset}"
log "References dir: ${JOB_QUEST_REFERENCES_DIR:-unset}"

if [ ! -f "$PROFILE" ]; then
  log "ERROR: profile.json not found at $PROFILE. Open Job Quest in your runtime and complete onboarding first."
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  log "ERROR: intel-agent-template.md not found at $TEMPLATE"
  exit 1
fi

log "Prompt template: $TEMPLATE"

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
SPECIFIC_COMPANIES="$(python3 -c "import json; d=json.load(open('$PROFILE')); print(', '.join(d.get('targetCompanies',{}).get('specific',[])))")"
INDUSTRIES="$(read_profile_list industries)"
VALUES="$(read_profile_list values)"
DEAL_BREAKERS="$(read_profile_list dealBreakers)"
WEAK_SPOTS="$(read_profile_list interviewWeakSpots)"
TODAY="$(date +%Y-%m-%d)"

# Account selection authorizes only bounded read-only collection, never new access.
ACCOUNTS="$JOB_QUEST_DATA_DIR/opportunity-accounts.json"
COLLECTOR="$JOB_QUEST_APP_ROOT/skill/bin/collect-outreach.cjs"
COLLECT_OUTREACH=0
OUTREACH_OWNER="$(python3 - "$JOB_QUEST_DATA_DIR/local-setup.json" <<'PYOWNER'
import json, sys
try:
    value = json.load(open(sys.argv[1]))
    print('external' if isinstance(value, dict) and value.get('schedule') == 'external' else 'native')
except FileNotFoundError:
    print('native')
except (ValueError, OSError):
    print('unknown')
PYOWNER
)"
if [ "$OUTREACH_OWNER" = "external" ]; then
  log "Outreach collection skipped: configured external review owns native outreach ingestion."
elif [ "$OUTREACH_OWNER" = "unknown" ]; then
  log "Outreach collection skipped: local setup unreadable; collector ownership unknown. Public daily work remains available."
elif [ -f "$ACCOUNTS" ]; then
  if python3 - "$ACCOUNTS" <<'PYACCOUNTS'
import json, sys
try:
    value = json.load(open(sys.argv[1]))
    accounts = value.get('accounts') if isinstance(value, dict) else None
    assert isinstance(accounts, list)
    assert all(isinstance(a, dict) and a.get('id') and a.get('label') and a.get('kind') in ('gmail', 'linkedin_email', 'linkedin') for a in accounts)
    sys.exit(0 if accounts else 1)
except (ValueError, OSError, AssertionError):
    sys.exit(2)
PYACCOUNTS
  then
    if [ -f "$COLLECTOR" ]; then COLLECT_OUTREACH=1; else log "Outreach unavailable: collection helper missing; account selection preserved."; fi
  else
    log "Outreach not collected: no valid selected source accounts."
  fi
fi

DAILY_OUTPUTS_PRESENT=0
for OUTPUT_KIND in intel quizzes tasks; do
  if [ -e "$JOB_QUEST_DATA_DIR/$OUTPUT_KIND/$TODAY.json" ]; then
    log "SKIP: existing $OUTPUT_KIND/$TODAY.json preserved."
    DAILY_OUTPUTS_PRESENT=1
  fi
done
if [ "$DAILY_OUTPUTS_PRESENT" -eq 1 ] && [ "$COLLECT_OUTREACH" -eq 0 ]; then exit 0; fi

OUTREACH_CANDIDATE=""
if [ "$COLLECT_OUTREACH" -eq 1 ]; then
  OUTREACH_CANDIDATE="$(mktemp "$LOG_DIR/outreach-candidate.XXXXXX")"
  rm -f "$OUTREACH_CANDIDATE"
fi

PROMPT_FILE="$(mktemp)"
cat > "$PROMPT_FILE" <<EOF
You are ${NAME}'s automated daily job hunt intelligence agent. Today is ${TODAY}. Your job is to write fresh content for the Job Quest Command Center at ${JOB_QUEST_DATA_DIR}.

## Profile
- Name: ${NAME}
- Target level: ${TARGET_LEVEL}
- Location: ${LOCATION}
- Strengths: ${STRENGTHS}
- Target company categories: ${CATEGORIES}
- Specific target companies: ${SPECIFIC_COMPANIES}
- Preferred industries: ${INDUSTRIES}
- Values and mission preferences: ${VALUES}
- Deal-breakers: ${DEAL_BREAKERS}
- Interview weak spots (bias prep toward these): ${WEAK_SPOTS}

## Deduplication
Read every JSON file in ${JOB_QUEST_DATA_DIR}/intel/ first. Match existing roles using canonical posting URL plus normalized company and title. Keep the same role identity when a listing changes; report material changes in availability or requirements rather than presenting a duplicate as new. Preserve saved/applied/skipped role state.

## Preserve existing work
Read existing dated tasks and quizzes before planning. Never overwrite, delete, or modify any existing intel, task, or quiz file, any role action/tracker state, coding progress, or saved practice. Suggest unfinished work in today's new tasks where helpful; do not mark older work complete. Keep all existing coding problems unchanged and append new problems only through add-problems.js. If any listed output file already exists, stop and report that it was preserved instead of replacing it.

EOF
if [ "$DAILY_OUTPUTS_PRESENT" -eq 0 ]; then
cat >> "$PROMPT_FILE" <<EOF
## Tasks

### 1. Discover 15-20 new roles
Search current company career pages, official ATS listings and LinkedIn Jobs for ${TARGET_LEVEL} Software Engineer roles matching the location, industries, values, specific companies and categories above. Exclude roles that violate stated deal-breakers. Rotate specific-company coverage and include comparable companies. Verify each posting at its source; a search snippet alone does not establish availability. Read the template's LinkedIn discovery contract. Prefer verified employer/ATS URLs; accept a source-read specific LinkedIn /jobs/view/<numeric-id> posting when it is the only available listing and its title, employer and availability are established. Record independent employer verification limits. Use only web tools or an already authorized browser exposed to this invocation; an interactive app browser is not proof of scheduled CLI access. Do not create a scraper/token store, read OS browser secrets or bypass tool restrictions through Bash. Bound LinkedIn to 2 result pages and 25 job detail pages. Write sourceCoverage in today's Intel JSON with actual queries, filters, pages/details read, remaining pagination and ready/partial/unavailable status; unavailable has checkedAt null. Capture company, role title, level, location, canonical URL, fit and evidence of current availability with a check date. Distinguish check date, first-seen date and posted date when known. Report material changes to an existing role without resetting the user's actions.

### 2. Find 8-10 interview tips
Search Blind, Reddit r/cscareerquestions, HackerNews, Glassdoor, levels.fyi. Focus on system design for ${TARGET_LEVEL} level, behavioral hacks, and negotiation tactics.

### 3. Create a 5-7 question quiz
Mix of 2-3 system design, 2 coding concept, 1-2 behavioral questions. Bias toward weak spots: ${WEAK_SPOTS}. Each question has exactly 4 options with a 0-indexed correctIndex and an explanation.

### 4. Create 8-10 daily tasks
Categories: coding, system-design, behavioral, research, networking, application. Each task MUST include a substantial \`content\` field (100-400 words for non-coding tasks) with a detailed markdown walkthrough that ${NAME} can read in the UI.

### 5. Add 3-5 adaptive coding problems
Read ${JOB_QUEST_DATA_DIR}/problems/progress.json to see what ${NAME} has solved. Generate problems calibrated to performance, each with a referenceSolution, and add them ONLY with: node ${JOB_QUEST_APP_ROOT}/skill/bin/add-problems.js <your-problems.json> --data-dir ${JOB_QUEST_DATA_DIR} (rules in the template's "Add coding problems" section). Never edit problems.json directly; fix and re-run on an error.

## Output files
- ${JOB_QUEST_DATA_DIR}/intel/${TODAY}.json
- ${JOB_QUEST_DATA_DIR}/quizzes/${TODAY}.json
- ${JOB_QUEST_DATA_DIR}/tasks/${TODAY}.json
- coding problems: via add-problems.js only

Each file's schema is documented in ${TEMPLATE}. Validate JSON before writing. When done, print a one-line summary: "Done: N roles, M quiz questions, K tasks, P new problems".
EOF

else
cat >> "$PROMPT_FILE" <<EOF
Today's native daily content already exists. This is OUTREACH ONLY: do not discover/write roles, tips, quizzes, tasks or problems; preserve all daily files exactly.
EOF
fi

if [ "$COLLECT_OUTREACH" -eq 1 ]; then
cat >> "$PROMPT_FILE" <<EOF

## Collect selected outreach sources (read-only)
Read the Outreach collection contract in ${TEMPLATE}. Read ${ACCOUNTS}; collect ONLY those selected accounts. Current runtime: ${JOB_QUEST_ACTIVE_RUNTIME}. Its visible tool inventory is the authority for capability; saved accessStatus is historical metadata, not proof of current access. Claude's allowed-tools policy permits only file/web/Bash tools, NOT inbox MCP tools: record those accounts unavailable; do not bypass that policy through Bash/network/browser credentials.
Use only already authorized read-only connector tools, or an already signed-in browser exposed to THIS invocation when a connector is unavailable. Verify the actual account identity before reading messages using connector metadata or visible account/profile identity and canonical profile URL; match the selected email/profile or established verified mapping, never a similar display name or another signed-in account. Interactive app browser access does not establish scheduled CLI browser access. For a selected direct linkedin account, inspect actual Messaging/InMail threads with the available connector/browser; notification email never substitutes for that review. Do not install a scraper/token store, extract cookies, read OS browser secrets or bypass runtime restrictions through Bash. Never create access, authorize/connect accounts, send, draft, archive, mark read, book meetings, or alter labels/settings. Limit each mailbox or LinkedIn messaging surface to recent recruiter conversations from the last 14 days, at most 25 threads and 2 search/list pages; describe actual query/date/page/reader bounds and remaining pagination in source.detail. Describe Messaging, InMail and invitation surfaces individually; capped, unreadable, inaccessible or unreviewed surfaces are partial coverage, and account/tool/identity failure is unavailable. Read relevant sent replies only within those bounded threads to determine whether a reply is owed. Unreviewed search hits are not reviewed conversations. For linkedin_email, review only LinkedIn notification emails in the verified selected mailbox; never claim direct LinkedIn, invitation or booking coverage.
Write one JSON candidate ONLY to ${OUTREACH_CANDIDATE}. Do not write canonical outreach brief/queue/accounts, native intel reports, decisions, drafts, holds, reminders, progress or role actions during this step. The host runner ingests this candidate conservatively after success. Include one sources record per selected account with truthful partial/ready/unavailable status; checkedAt reflects an actual bounded review, and is null when unavailable. Missing tools/account mismatch/blocked permissions are unavailable, never an empty successful scan. Preserve all found source links/account provenance; do not invent official listings, sent evidence, freshness, or a reply draft. Read ${JOB_QUEST_DATA_DIR}/outreach/brief.json and ${JOB_QUEST_DATA_DIR}/outreach/queue.json read-only if present before assigning IDs. Reuse the exact existing record id, including legacy ids, when verified source thread/message URLs or explicit thread identifiers establish the same conversation. Cross-channel Gmail/LinkedIn notifications require an explicit linked conversation or strong matching recruiter identity, precise role and specific message details; company alone never matches. Preserve every verified channel/source link and account provenance on that existing id. Do not merge independently saved records, drafts or decisions, even if they look duplicated. If multiple existing ids match ambiguously, omit that candidate and explain the identity conflict in source.detail rather than minting another id or combining saved states. Only a genuinely new conversation receives a stable sanitized account-and-thread id. Never replace an existing legacy id with a newly generated one. Include only grounded recruiter outreach records (kind recruiter) in this step; LinkedIn/public listing discovery belongs to the existing native Intel step and its sourceCoverage, not another collector. If no tools are available, still write a coverage-only candidate with opportunities: [].
EOF
fi

STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"

trap 'rm -f "$PROMPT_FILE" "$STDOUT_FILE" "$STDERR_FILE" "${OUTREACH_CANDIDATE:-}"; release_run_lock' EXIT
set +e
if [ "$JOB_QUEST_ACTIVE_RUNTIME" = "codex" ]; then
  job_quest_run_prompt_file "$PROMPT_FILE" --approve-for-me >"$STDOUT_FILE" 2>"$STDERR_FILE"
  EXIT_CODE=$?
else
  job_quest_run_prompt_file "$PROMPT_FILE" --allowed-tools Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash >"$STDOUT_FILE" 2>"$STDERR_FILE"
  EXIT_CODE=$?
fi
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  if [ "$COLLECT_OUTREACH" -eq 1 ]; then
    if [ -f "$OUTREACH_CANDIDATE" ]; then
      if node "$COLLECTOR" --input "$OUTREACH_CANDIDATE" --data-dir "$JOB_QUEST_DATA_DIR" >>"$LOG_FILE" 2>&1; then
        log "Outreach candidate ingested; consult per-account coverage for actual access/review scope."
      else
        log "FAILED: outreach candidate rejected; canonical user decisions were not replaced."
        EXIT_CODE=1
      fi
    else
      log "FAILED: outreach candidate missing; no source review claimed."
      EXIT_CODE=1
    fi
  fi
  log "Runtime completed (collection exit $EXIT_CODE)"
  log "Summary: $(tail -1 "$STDOUT_FILE")"
else
  log "FAILED: exit code $EXIT_CODE"
  log "Runtime command failed: ${JOB_QUEST_RUNTIME_COMMAND:-unknown} ${JOB_QUEST_RUNTIME_COMMAND_ARGS[*]:-}"
  log "stderr: $(head -c 400 "$STDERR_FILE" | tr '\n' ' ')"
fi

rm -f "$PROMPT_FILE" "$STDOUT_FILE" "$STDERR_FILE"
log "=== Daily intel run finished (exit $EXIT_CODE) ==="
exit "$EXIT_CODE"
