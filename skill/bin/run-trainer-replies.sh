#!/bin/bash
# Poll the trainer iMessage thread for replies and run interviewer-style exchanges.
#
# Invoked every ~2 minutes by launchd THROUGH the dedicated FDA helper binary
# (~/.job-quest/bin/trainer-messages-reader) — the helper is the launchd
# program, so the Messages-database read below is attributed to it and only it
# needs Full Disk Access. Running this script directly from a terminal works
# only if that terminal app itself has Full Disk Access.
#
# Behavior:
#   - New texts from the user in the trainer thread are treated as answers to
#     the active question. The trainer responds like an interviewer: scored
#     feedback PLUS one probing follow-up question, for up to 3 follow-up
#     rounds, then a final assessment comparing where the answer started.
#   - Keywords: "skip" passes on the current question, "next" gets a fresh
#     question, "done" ends the current exchange with a final assessment.
#   - Messages sent by the trainer itself (marker-emoji prefixes) are ignored,
#     which also makes the self-chat case (texting your own number) safe.

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
STATE_FILE="$TRAINER_DIR/reply-state.json"
LOG_DIR="$JOB_QUEST_DATA_DIR/logs"
LOCK_DIR="$TRAINER_DIR/.replies.lock"
CHAT_DB="$HOME/Library/Messages/chat.db"
mkdir -p "$LOG_DIR" "$TRAINER_DIR"
LOG_FILE="$LOG_DIR/trainer-replies.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2
}

if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

read_config() {
  python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('$1',''))"
}

ENABLED="$(read_config enabled)"
PHONE="$(read_config phone)"

if [ -z "$PHONE" ]; then
  exit 0
fi
if [ "$ENABLED" != "True" ] && [ "$ENABLED" != "true" ]; then
  exit 0
fi

# Single-flight lock: evaluation can outlast the poll interval. Steal locks
# older than 10 minutes (crashed run).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    log "Stealing stale lock."
    rmdir "$LOCK_DIR" 2>/dev/null || true
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

send_imessage() {
  local text="$1"
  local err
  set +e
  err=$(osascript - "$PHONE" "$text" 2>&1 <<'OSA'
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
  local code=$?
  set -e
  if [ $code -ne 0 ]; then
    log "WARNING: iMessage send failed: $(echo "$err" | head -c 200 | tr '\n' ' ')"
  fi
  return 0
}

# Read new incoming texts. Prints JSON: {"status": "...", "rowId": N, "texts": [...]}
#   status: no-db | no-access | initialized | quiet | empty | ok
POLL_RESULT="$(python3 - "$CHAT_DB" "$PHONE" "$STATE_FILE" <<'PY'
import datetime
import json
import os
import re
import sqlite3
import sys

db_path, handle, state_file = sys.argv[1:4]

# Prefixes of messages the trainer itself sends. Needed because texting your
# own number is a self-chat where is_from_me can't distinguish directions.
OWN_PREFIXES = ('\U0001F3AF', '\U0001F4DD', '\U0001F3C1', '⏭', '❓', '⚠')
APPLE_EPOCH = 978307200  # 2001-01-01 in unix seconds
DEBOUNCE_SECONDS = 75

def out(status, row_id=0, texts=None):
    print(json.dumps({'status': status, 'rowId': row_id, 'texts': texts or []}))
    sys.exit(0)

if not os.path.exists(db_path):
    out('no-db')

def parse_attributed_body(blob):
    """Best-effort text extraction from the typedstream attributedBody blob
    (newer macOS stores some message text there instead of the text column)."""
    if not blob:
        return None
    try:
        idx = blob.find(b'NSString')
        if idx == -1:
            return None
        content = blob[idx + len(b'NSString') + 5:]
        if not content:
            return None
        if content[0] == 0x81:
            length = int.from_bytes(content[1:3], 'little')
            raw = content[3:3 + length]
        else:
            length = content[0]
            raw = content[1:1 + length]
        return raw.decode('utf-8', errors='ignore') or None
    except Exception:
        return None

try:
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    cur = conn.cursor()
    # Normalize the handle: match chat identifiers with or without formatting.
    digits = re.sub(r'\D', '', handle)
    cur.execute(
        """
        SELECT m.ROWID, m.text, m.attributedBody, m.date
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE (c.chat_identifier = ? OR replace(replace(replace(c.chat_identifier,'+',''),'-',''),' ','') = ?)
        ORDER BY m.ROWID
        """,
        (handle, digits),
    )
    rows = cur.fetchall()
    conn.close()
except sqlite3.OperationalError as e:
    if 'authorization denied' in str(e) or 'unable to open' in str(e):
        out('no-access')
    raise

max_row = rows[-1][0] if rows else 0

state = {}
if os.path.exists(state_file):
    try:
        with open(state_file) as fh:
            state = json.load(fh)
    except Exception:
        state = {}

if 'lastRowId' not in state:
    # First run: mark everything already in the thread as seen.
    with open(state_file, 'w') as fh:
        json.dump({'lastRowId': max_row}, fh)
    out('initialized', max_row)

last = state['lastRowId']
now = datetime.datetime.now(datetime.timezone.utc).timestamp()

fresh = []
newest_age = None
for row_id, text, body, date_ns in rows:
    if row_id <= last:
        continue
    content = text or parse_attributed_body(body)
    if not content or not content.strip():
        continue
    content = content.strip()
    if content.startswith(OWN_PREFIXES):
        continue
    # Self-chat: each text is stored twice (sent + received copy) — drop the dup.
    if fresh and fresh[-1]['text'] == content:
        continue
    age = now - (date_ns / 1e9 + APPLE_EPOCH) if date_ns else 9999
    newest_age = age
    fresh.append({'rowId': row_id, 'text': content})

if not fresh:
    # Advance past trainer-sent/empty rows so they aren't rescanned forever.
    with open(state_file, 'w') as fh:
        json.dump({'lastRowId': max_row}, fh)
    out('empty', max_row)

# Debounce: if the newest text just arrived, wait a cycle so multi-text
# answers arrive as one batch. State is NOT advanced.
if newest_age is not None and newest_age < DEBOUNCE_SECONDS:
    out('quiet', last)

with open(state_file, 'w') as fh:
    json.dump({'lastRowId': max_row}, fh)
out('ok', max_row, fresh)
PY
)"

STATUS="$(echo "$POLL_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")"

case "$STATUS" in
  no-db)
    log "SKIP: Messages database not found at $CHAT_DB."
    exit 0
    ;;
  no-access)
    log "BLOCKED: no Full Disk Access. Grant it to ~/.job-quest/bin/trainer-messages-reader in System Settings > Privacy & Security > Full Disk Access."
    exit 0
    ;;
  initialized)
    log "Initialized reply tracking (existing thread history marked as seen)."
    exit 0
    ;;
  quiet|empty)
    exit 0
    ;;
esac

ANSWER="$(echo "$POLL_RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('\n\n'.join(t['text'] for t in d['texts']))
")"

log "New reply received ($(echo "$ANSWER" | wc -c | tr -d ' ') chars)."

NORMALIZED="$(echo "$ANSWER" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]' | tr -d '.!')"

# --- keyword: skip ---
if [ "$NORMALIZED" = "skip" ] || [ "$NORMALIZED" = "pass" ]; then
  SKIPPED="$(python3 - "$QUESTIONS_FILE" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    qs = json.load(open(p))
except Exception:
    qs = []
for q in reversed(qs):
    if q.get('status') in ('pending', 'in-progress'):
        q['status'] = 'skipped'
        tmp = p + '.tmp'
        json.dump(qs, open(tmp, 'w'), indent=2)
        os.replace(tmp, p)
        print(q.get('company', ''))
        break
PY
)"
  if [ -n "$SKIPPED" ]; then
    log "Skipped question ($SKIPPED)."
    send_imessage "⏭ Skipped the $SKIPPED question. Next one arrives on the hour — or text 'next' for one now."
  else
    send_imessage "❓ Nothing to skip — no active question. Text 'next' to get one."
  fi
  exit 0
fi

# --- keyword: next ---
if [ "$NORMALIZED" = "next" ] || [ "$NORMALIZED" = "another" ] || [ "$NORMALIZED" = "new" ]; then
  log "On-demand question requested via iMessage."
  "$JOB_QUEST_BIN_DIR/run-interview-trainer.sh" --force >>"$LOG_FILE" 2>&1 || \
    send_imessage "⚠️ Couldn't generate a question right now — check the trainer logs."
  exit 0
fi

# --- keyword: done (wrap up the current exchange) ---
FORCE_COMPLETE=0
if [ "$NORMALIZED" = "done" ] || [ "$NORMALIZED" = "wrapup" ] || [ "$NORMALIZED" = "finish" ]; then
  FORCE_COMPLETE=1
  ANSWER=""
fi

# --- interviewer exchange: evaluate + follow-up (or final assessment) ---
# NOTE: python output goes to temp files, not $(...) capture — macOS bash 3.2
# cannot parse heredocs inside command substitution when the body mixes
# quotes and parentheses.
PROMPT_FILE="$(mktemp)"
META_FILE="$(mktemp)"
FORCE_COMPLETE="$FORCE_COMPLETE" ANSWER="$ANSWER" python3 - "$QUESTIONS_FILE" "$PROMPT_FILE" > "$META_FILE" <<'PY'
import json
import os
import sys

questions_file, prompt_file = sys.argv[1:3]
answer = os.environ.get('ANSWER', '')
force_complete = os.environ.get('FORCE_COMPLETE') == '1'
MAX_FOLLOW_UPS = 3

try:
    qs = json.load(open(questions_file))
except Exception:
    qs = []

target = None
for q in reversed(qs):
    if q.get('status') in ('pending', 'in-progress', 'answered'):
        target = q
        break

if target is None:
    print(json.dumps({'status': 'no-target'}))
    sys.exit(0)

if force_complete and target.get('status') != 'in-progress':
    print(json.dumps({'status': 'nothing-in-progress'}))
    sys.exit(0)

exchanges = target.get('exchanges') or []
# Legacy single-shot records: fold answer/evaluation into the exchange model.
if not exchanges and target.get('answer') and target.get('evaluation'):
    exchanges = [
        {'role': 'candidate', 'text': target['answer']},
        {'role': 'interviewer', 'evaluation': target['evaluation'], 'followUp': None},
    ]

rounds = sum(1 for e in exchanges if e.get('role') == 'interviewer')
if rounds >= MAX_FOLLOW_UPS:
    force_complete = True

conversation = []
for e in exchanges:
    if e.get('role') == 'candidate':
        conversation.append(f"CANDIDATE:\n{e.get('text','')}")
    else:
        ev = e.get('evaluation') or {}
        line = f"YOU (interviewer, scored {ev.get('score','?')}/10): {ev.get('feedback','')}"
        if e.get('followUp'):
            line += f"\nYOUR FOLLOW-UP QUESTION: {e['followUp']}"
        conversation.append(line)
if answer:
    conversation.append(f"CANDIDATE:\n{answer}")
conversation_text = '\n\n'.join(conversation) if conversation else '(no answer yet)'

role_kind = 'senior hiring manager' if target.get('category') == 'behavioral' else 'senior technical interviewer'
if force_complete:
    closing = 'This is the END of the exchange. Set "complete" to true, "followUp" to null, and give your final assessment of the candidate\'s overall performance across the whole conversation, with a "progress" sentence describing how the answer evolved from where it started.'
else:
    closing = f'''If the answer is now strong (9+) or fully covers what you look for, set "complete" to true, "followUp" to null, and include a "progress" sentence describing how the answer evolved.
Otherwise set "complete" to false and ask ONE follow-up question in "followUp" — the single most revealing probe a real interviewer would ask next: dig into the biggest gap, challenge an assumption, or push one level deeper. Never re-ask something already answered. (You have {MAX_FOLLOW_UPS - rounds} follow-up(s) left in this exchange.)'''

prompt = f"""You are a {role_kind} at {target.get('company','the company')} conducting a live interview for the "{target.get('role','')}" role. The candidate types answers on a phone, so judge substance, not polish.

THE QUESTION YOU ASKED ({target.get('category','')}): {target.get('question','')}

WHAT A STRONG ANSWER COVERS: {target.get('whatTheyLookFor') or 'Depth, structure, and specificity appropriate for the role level.'}

THE CONVERSATION SO FAR:
{conversation_text}

Assess the candidate's cumulative performance on this question so far. {closing}

Your entire response must be a single JSON object with no other text:
{{"score":0,"maxScore":10,"strengths":["strength"],"improvements":["gap"],"feedback":"2-3 crisp sentences on the latest response in context","followUp":"one probing question or null","complete":false,"progress":"only when complete: one sentence on how the answer evolved"}}

Score 0-10 for the overall answer as it stands now (it should move as the candidate improves). Keep everything crisp — it is read as a text message. Output ONLY the JSON."""

with open(prompt_file, 'w') as fh:
    fh.write(prompt)

print(json.dumps({'status': 'ok', 'id': target.get('id'), 'company': target.get('company'),
                  'category': target.get('category'), 'rounds': rounds,
                  'forceComplete': force_complete}))
PY

TARGET_META="$(cat "$META_FILE")"
rm -f "$META_FILE"
META_STATUS="$(echo "$TARGET_META" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")"

if [ "$META_STATUS" = "no-target" ]; then
  rm -f "$PROMPT_FILE"
  send_imessage "❓ No active question to grade. Text 'next' and I'll send one."
  exit 0
fi
if [ "$META_STATUS" = "nothing-in-progress" ]; then
  rm -f "$PROMPT_FILE"
  send_imessage "❓ No exchange in progress to wrap up. Text 'next' for a new question."
  exit 0
fi

TARGET_ID="$(echo "$TARGET_META" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")"
log "Interview exchange for $(echo "$TARGET_META" | python3 -c "import json,sys; m=json.load(sys.stdin); print(m['company'], '|', m['category'], '| round', m['rounds']+1)")..."

set +e
RAW_EVAL="$("$JOB_QUEST_BIN_DIR/generate-plan.sh" "$PROMPT_FILE" 2>>"$LOG_FILE")"
EVAL_EXIT=$?
set -e
rm -f "$PROMPT_FILE"

if [ $EVAL_EXIT -ne 0 ] || [ -z "$RAW_EVAL" ]; then
  log "FAILED: evaluation runtime error (exit $EVAL_EXIT)."
  send_imessage "⚠️ Got your answer but the evaluation failed — reply again to retry, or answer from the dashboard."
  exit 0
fi

REPLY_FILE="$(mktemp)"
set +e
RAW_EVAL="$RAW_EVAL" TARGET_ID="$TARGET_ID" ANSWER="$ANSWER" FORCE_COMPLETE_META="$TARGET_META" python3 - "$QUESTIONS_FILE" > "$REPLY_FILE" <<'PY'
import datetime
import json
import os
import re
import sys

raw = os.environ['RAW_EVAL'].strip()
target_id = os.environ['TARGET_ID']
answer = os.environ.get('ANSWER', '')
meta = json.loads(os.environ['FORCE_COMPLETE_META'])
questions_file = sys.argv[1]

result = None
try:
    result = json.loads(raw)
except Exception:
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', raw)
    if m:
        try:
            result = json.loads(m.group(1).strip())
        except Exception:
            pass
if result is None:
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
                        result = json.loads(raw[start:i + 1])
                    except Exception:
                        pass
                    break
if not result or result.get('error') or 'score' not in result:
    sys.exit('eval-parse-failed')

now = datetime.datetime.now(datetime.timezone.utc).isoformat()
follow_up = (result.get('followUp') or '').strip() or None
complete = bool(result.get('complete')) or meta.get('forceComplete') or follow_up is None

eval_core = {
    'score': result.get('score', 0),
    'maxScore': result.get('maxScore', 10),
    'strengths': result.get('strengths') or [],
    'improvements': result.get('improvements') or [],
    'feedback': result.get('feedback', ''),
}

try:
    qs = json.load(open(questions_file))
except Exception:
    qs = []

target = None
for q in qs:
    if q.get('id') == target_id:
        target = q
        break
if target is None:
    sys.exit('question-vanished')

exchanges = target.get('exchanges') or []
if not exchanges and target.get('answer') and target.get('evaluation'):
    exchanges = [
        {'role': 'candidate', 'text': target['answer'], 'at': target.get('answeredAt')},
        {'role': 'interviewer', 'evaluation': target['evaluation'], 'followUp': None, 'at': target.get('answeredAt')},
    ]
if answer:
    exchanges.append({'role': 'candidate', 'text': answer, 'at': now})
exchanges.append({'role': 'interviewer', 'evaluation': eval_core,
                  'followUp': None if complete else follow_up, 'at': now})

target['exchanges'] = exchanges
target['evaluation'] = eval_core
if not target.get('initialEvaluation'):
    target['initialEvaluation'] = eval_core
if not target.get('answer') and answer:
    target['answer'] = answer

if complete:
    target['status'] = 'answered'
    target['answeredAt'] = now
    target['finalEvaluation'] = eval_core
    if result.get('progress'):
        target['progress'] = result['progress']
else:
    target['status'] = 'in-progress'

tmp = questions_file + '.tmp'
json.dump(qs, open(tmp, 'w'), indent=2)
os.replace(tmp, questions_file)

score = eval_core['score']
emoji = '🟢' if score >= 8 else '🟡' if score >= 6 else '🔴'

if complete:
    init = (target.get('initialEvaluation') or {}).get('score')
    header = f"🏁 Final: {score}/{eval_core['maxScore']} {emoji} — {target.get('company','')}"
    if init is not None and init != score:
        header += f" (started at {init}/10)"
    parts = [header]
    if eval_core['feedback']:
        parts.append(eval_core['feedback'])
    if target.get('progress'):
        parts.append('📈 ' + target['progress'])
    parts.append("Full breakdown on the dashboard. Next question arrives on the hour — or text 'next'.")
else:
    parts = [f"📝 {score}/{eval_core['maxScore']} {emoji} — {target.get('company','')}"]
    if eval_core['feedback']:
        parts.append(eval_core['feedback'])
    parts.append('🎙️ Follow-up: ' + follow_up)
    parts.append("(Reply to continue, or 'done' for the final assessment)")

text = '\n\n'.join(parts)
if len(text) > 1500:
    text = text[:1500] + '…'
print(text)
PY
COMPOSE_EXIT=$?
set -e
REPLY_TEXT="$(cat "$REPLY_FILE")"
rm -f "$REPLY_FILE"

if [ $COMPOSE_EXIT -ne 0 ] || [ -z "$REPLY_TEXT" ]; then
  log "FAILED: could not parse evaluation output: $(echo "$RAW_EVAL" | head -c 200 | tr '\n' ' ')"
  send_imessage "⚠️ Got your answer but couldn't parse the evaluation — reply again to retry, or answer from the dashboard."
  exit 0
fi

send_imessage "$REPLY_TEXT"
log "Interviewer reply sent."
