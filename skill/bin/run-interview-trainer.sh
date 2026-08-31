#!/bin/bash
# Run the hourly interview trainer via the active runtime CLI.
#
# Reads the user's profile plus the roles they have saved/applied in Job Quest,
# generates ONE interview question tailored to those roles, appends it to
# ~/.job-quest/data/trainer/questions.json, and delivers it via iMessage
# (macOS) when a phone/handle is configured.
#
# Invoked hourly by the schedule installed via install-trainer-schedule.sh,
# or manually / from the dashboard's "Ask me one now" button.

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

TRAINER_DIR="$JOB_QUEST_DATA_DIR/trainer"
CONFIG_FILE="$TRAINER_DIR/config.json"
QUESTIONS_FILE="$TRAINER_DIR/questions.json"
PROFILE="$JOB_QUEST_DATA_DIR/profile.json"
LOG_DIR="$JOB_QUEST_DATA_DIR/logs"
mkdir -p "$LOG_DIR" "$TRAINER_DIR"
LOG_FILE="$LOG_DIR/interview-trainer.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2
}

log "=== Interview trainer run started ==="

if [ ! -f "$PROFILE" ]; then
  log "ERROR: profile.json not found. Complete Job Quest onboarding first."
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  log "SKIP: no trainer config at $CONFIG_FILE. Ask Job Quest to set up the interview trainer."
  exit 0
fi

read_config() {
  python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('$1',''))"
}

ENABLED="$(read_config enabled)"
PHONE="$(read_config phone)"
START_HOUR="$(read_config startHour)"
END_HOUR="$(read_config endHour)"
START_HOUR="${START_HOUR:-9}"
END_HOUR="${END_HOUR:-21}"

if [ "$ENABLED" != "True" ] && [ "$ENABLED" != "true" ]; then
  log "SKIP: trainer is paused (enabled=false in config.json)."
  exit 0
fi

# Guard the delivery window even if the schedule fires outside it (cron ranges,
# manual runs are exempt via --force).
FORCE=false
[ "${1:-}" = "--force" ] && FORCE=true
HOUR_NOW=$(date +%H | sed 's/^0//')
if [ "$FORCE" = false ] && { [ "$HOUR_NOW" -lt "$START_HOUR" ] || [ "$HOUR_NOW" -gt "$END_HOUR" ]; }; then
  log "SKIP: current hour $HOUR_NOW outside window $START_HOUR-$END_HOUR."
  exit 0
fi

# Build the context block (profile, saved/applied roles, recent history) in one
# pass so the runtime CLI needs no tools at all.
CONTEXT_FILE="$(mktemp)"
python3 - "$JOB_QUEST_DATA_DIR" > "$CONTEXT_FILE" <<'PY'
import json, os, sys

data_dir = sys.argv[1]

def load(p, default):
    try:
        with open(os.path.join(data_dir, p)) as fh:
            return json.load(fh)
    except Exception:
        return default

profile = load('profile.json', {})
actions = load('role-actions.json', {'saved': [], 'applied': []})
tracker = load('role-tracker.json', {})
questions = load('trainer/questions.json', [])

# Roles the user cares about: applied > tracked > saved.
role_keys = []
for k in actions.get('applied', []):
    role_keys.append((k, 'applied'))
for k in tracker:
    if k not in [r for r, _ in role_keys]:
        role_keys.append((k, tracker[k].get('stage', 'tracked')))
for k in actions.get('saved', []):
    if k not in [r for r, _ in role_keys]:
        role_keys.append((k, 'saved'))

# Pull fit paragraphs from intel history where available.
fits = {}
intel_dir = os.path.join(data_dir, 'intel')
if os.path.isdir(intel_dir):
    for f in sorted(os.listdir(intel_dir), reverse=True)[:30]:
        if not f.endswith('.json'):
            continue
        day = load(os.path.join('intel', f), {})
        for r in day.get('roles', []):
            key = f"{r.get('company')}|{r.get('role')}"
            fits.setdefault(key, r.get('fit', ''))

roles_out = []
for key, stage in role_keys[:25]:
    company, _, role = key.partition('|')
    roles_out.append({
        'roleKey': key, 'company': company, 'role': role, 'stage': stage,
        'fit': (fits.get(key) or '')[:400],
    })

history = []
for q in questions[-20:]:
    ev = q.get('evaluation') or {}
    history.append({
        'roleKey': q.get('roleKey'), 'category': q.get('category'),
        'question': (q.get('question') or '')[:140],
        'status': q.get('status'), 'score': ev.get('score'),
    })

print(json.dumps({
    'profile': {k: profile.get(k) for k in
                ('name', 'currentRole', 'yearsExperience', 'strengths',
                 'targetLevel', 'interviewWeakSpots')},
    'roles': roles_out,
    'recentQuestions': history,
}, indent=2))
PY

if ! python3 -c "import json,sys; d=json.load(open('$CONTEXT_FILE')); sys.exit(0 if d['roles'] else 1)"; then
  log "SKIP: no saved, tracked, or applied roles yet. Save roles in Job Quest first."
  rm -f "$CONTEXT_FILE"
  exit 0
fi

NAME="$(python3 -c "import json; print(json.load(open('$PROFILE')).get('name','there'))")"

PROMPT_FILE="$(mktemp)"
{
  cat <<EOF
You are ${NAME}'s interview trainer. Generate exactly ONE interview question for this hour's practice session.

## Candidate context (profile, target roles, recent question history)
EOF
  cat "$CONTEXT_FILE"
  cat <<'EOF'

## Rules
- Pick ONE role from "roles" above, favoring stage "applied", then tracked stages, then "saved". Rotate across roles and categories relative to recentQuestions — never repeat or closely paraphrase a recent question.
- Choose the category (system-design, coding, technical, or behavioral) that best probes a weak spot given recent scores: low or missing scores in a category mean it needs more reps.
- The question must be SPECIFIC to the chosen company and role (its product, scale, or stack), phrased the way a real interviewer at that company would ask it, and answerable in writing in 10-20 minutes.
- "whatTheyLookFor" is 2-3 sentences on what a strong answer covers.

## Output
Respond with ONLY this JSON object, no other text, no code fences:
{"roleKey":"Company|Role Title","company":"...","role":"...","category":"system-design|coding|technical|behavioral","question":"...","whatTheyLookFor":"..."}
EOF
} > "$PROMPT_FILE"

STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"

set +e
if [ "$JOB_QUEST_ACTIVE_RUNTIME" = "codex" ]; then
  job_quest_run_prompt_file "$PROMPT_FILE" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  EXIT_CODE=$?
else
  job_quest_run_prompt_file "$PROMPT_FILE" --allowed-tools "" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  EXIT_CODE=$?
fi
set -e

rm -f "$PROMPT_FILE" "$CONTEXT_FILE"

if [ "$EXIT_CODE" -ne 0 ]; then
  log "FAILED: runtime exit $EXIT_CODE"
  log "stderr: $(head -c 400 "$STDERR_FILE" | tr '\n' ' ')"
  rm -f "$STDOUT_FILE" "$STDERR_FILE"
  log "=== Interview trainer run finished (exit $EXIT_CODE) ==="
  exit "$EXIT_CODE"
fi

# Parse the question JSON and append it to questions.json.
QUESTION_JSON="$(python3 - "$STDOUT_FILE" <<'PY'
import json, re, sys

raw = open(sys.argv[1]).read().strip()
obj = None
try:
    obj = json.loads(raw)
except Exception:
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', raw)
    if m:
        try:
            obj = json.loads(m.group(1).strip())
        except Exception:
            pass
if obj is None:
    start = raw.find('{"')
    if start >= 0:
        depth = 0
        for i in range(start, len(raw)):
            if raw[i] == '{':
                depth += 1
            elif raw[i] == '}':
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(raw[start:i + 1])
                    except Exception:
                        pass
                    break
if not obj or not obj.get('question'):
    sys.exit('could not parse question JSON from runtime output')
print(json.dumps(obj))
PY
)" || {
  log "FAILED: could not parse question from runtime output: $(head -c 300 "$STDOUT_FILE" | tr '\n' ' ')"
  rm -f "$STDOUT_FILE" "$STDERR_FILE"
  exit 1
}
rm -f "$STDOUT_FILE" "$STDERR_FILE"

SUMMARY="$(QUESTION_JSON="$QUESTION_JSON" python3 - "$QUESTIONS_FILE" <<'PY'
import json, os, sys, time
from datetime import datetime, timezone

questions_file = sys.argv[1]
q = json.loads(os.environ['QUESTION_JSON'])

try:
    with open(questions_file) as fh:
        questions = json.load(fh)
except Exception:
    questions = []

record = {
    'id': f'tq_{int(time.time())}',
    'askedAt': datetime.now(timezone.utc).isoformat(),
    'roleKey': q.get('roleKey', ''),
    'company': q.get('company', ''),
    'role': q.get('role', ''),
    'category': q.get('category', 'technical'),
    'question': q['question'],
    'whatTheyLookFor': q.get('whatTheyLookFor', ''),
    'status': 'pending',
    'answer': None,
    'evaluation': None,
    'answeredAt': None,
}
questions.append(record)
tmp = questions_file + '.tmp'
with open(tmp, 'w') as fh:
    json.dump(questions, fh, indent=2)
os.replace(tmp, questions_file)
print(f"{record['company']} | {record['category']}")
PY
)"

log "Question saved: $SUMMARY (total $(python3 -c "import json; print(len(json.load(open('$QUESTIONS_FILE'))))"))"

# Deliver via iMessage on macOS when a handle is configured.
if [[ "$OSTYPE" == darwin* ]] && [ -n "$PHONE" ]; then
  MESSAGE="$(QUESTION_JSON="$QUESTION_JSON" python3 <<'PY'
import json, os

q = json.loads(os.environ['QUESTION_JSON'])
text = q['question']
if len(text) > 700:
    text = text[:700] + '…'
print(f"🎯 Interview Trainer — {q.get('company','')} ({q.get('category','')})\n\n{text}\n\nAnswer at http://localhost:3847 → Trainer")
PY
)"
  set +e
  OSA_ERR=$(osascript - "$PHONE" "$MESSAGE" 2>&1 <<'OSA'
on run argv
  set targetHandle to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant targetHandle of targetService
    send messageText to targetBuddy
  end tell
end run
OSA
)
  OSA_EXIT=$?
  set -e
  if [ "$OSA_EXIT" -eq 0 ]; then
    log "iMessage sent to $PHONE"
  else
    log "WARNING: iMessage delivery failed (question still saved): $(echo "$OSA_ERR" | head -c 300 | tr '\n' ' ')"
    log "If this mentions 'not authorized', allow automation in System Settings > Privacy & Security > Automation."
  fi
else
  log "Delivery skipped (no phone configured or not macOS)."
fi

log "=== Interview trainer run finished (exit 0) ==="
