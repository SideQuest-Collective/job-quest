#!/bin/bash
# Poll the trainer iMessage thread for replies and respond with AI feedback.
#
# Invoked every ~2 minutes by launchd THROUGH the dedicated FDA helper binary
# (~/.job-quest/bin/trainer-messages-reader) — the helper is the launchd
# program, so the Messages-database read below is attributed to it and only it
# needs Full Disk Access. Running this script directly from a terminal works
# only if that terminal app itself has Full Disk Access.
#
# Behavior:
#   - New texts from the user in the trainer thread are treated as the answer
#     to the most recent question; the same role-specific evaluation used by
#     the dashboard runs and the score/feedback is texted back.
#   - Reply "skip" to skip the current question, "next" for a fresh question.
#   - Replying again after feedback re-evaluates (iterate on your answer).
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
OWN_PREFIXES = ('\U0001F3AF', '\U0001F4DD', '⏭', '❓', '⚠')
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
    if q.get('status') == 'pending':
        q['status'] = 'skipped'
        tmp = p + '.tmp'
        json.dump(qs, open(tmp, 'w'), indent=2)
        os.replace(tmp, p)
        print(q.get('company', ''))
        break
PY
)"
  if [ -n "$SKIPPED" ]; then
    log "Skipped pending question ($SKIPPED)."
    send_imessage "⏭ Skipped the $SKIPPED question. Next one arrives on the hour — or text 'next' for one now."
  else
    send_imessage "❓ Nothing to skip — no pending question. Text 'next' to get one."
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

# --- otherwise: treat as an answer to the most recent question ---
TARGET_JSON="$(python3 - "$QUESTIONS_FILE" <<'PY'
import json, sys
try:
    qs = json.load(open(sys.argv[1]))
except Exception:
    qs = []
for q in reversed(qs):
    if q.get('status') in ('pending', 'answered'):
        print(json.dumps(q))
        break
PY
)"

if [ -z "$TARGET_JSON" ]; then
  send_imessage "❓ No active question to grade. Text 'next' and I'll send one."
  exit 0
fi

PROMPT_FILE="$(mktemp)"
TARGET_JSON="$TARGET_JSON" ANSWER="$ANSWER" python3 > "$PROMPT_FILE" <<'PY'
import json, os

q = json.loads(os.environ['TARGET_JSON'])
answer = os.environ['ANSWER']
role_kind = 'senior hiring manager' if q.get('category') == 'behavioral' else 'senior technical interviewer'
print(f"""You are a {role_kind} at {q.get('company','the company')} evaluating a candidate's answer for the "{q.get('role','')}" role. The answer was typed on a phone, so judge substance, not polish or formatting.

QUESTION ({q.get('category','')}): {q.get('question','')}

WHAT A STRONG ANSWER COVERS: {q.get('whatTheyLookFor') or 'Depth, structure, and specificity appropriate for the role level.'}

CANDIDATE'S ANSWER:
{answer}

Evaluate the answer as {q.get('company','the company')} would for this role. Your entire response must be a single JSON object with no other text:
{{"score":0,"maxScore":10,"strengths":["strength 1"],"improvements":["area to improve 1"],"feedback":"2-3 sentence overall feedback referencing the company/role context"}}

Score 0-10 where: 0-3=poor, 4-5=needs work, 6-7=good, 8-9=strong, 10=excellent. Keep feedback, strengths, and improvements crisp — they will be read as a text message. Output ONLY the JSON.""")
PY

log "Evaluating answer for $(echo "$TARGET_JSON" | python3 -c "import json,sys; q=json.load(sys.stdin); print(q['company'], '|', q['category'])")..."

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

REPLY_TEXT="$(RAW_EVAL="$RAW_EVAL" TARGET_JSON="$TARGET_JSON" ANSWER="$ANSWER" python3 - "$QUESTIONS_FILE" <<'PY'
import datetime
import json
import os
import re
import sys

raw = os.environ['RAW_EVAL'].strip()
target = json.loads(os.environ['TARGET_JSON'])
answer = os.environ['ANSWER']
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

# Persist onto the question record.
try:
    qs = json.load(open(questions_file))
except Exception:
    qs = []
for q in qs:
    if q.get('id') == target.get('id'):
        q['answer'] = answer
        q['evaluation'] = result
        q['status'] = 'answered'
        q['answeredAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        break
tmp = questions_file + '.tmp'
json.dump(qs, open(tmp, 'w'), indent=2)
os.replace(tmp, questions_file)

score = result.get('score', 0)
emoji = '🟢' if score >= 8 else '🟡' if score >= 6 else '🔴'
parts = [f"📝 {score}/{result.get('maxScore', 10)} {emoji} — {target.get('company','')}"]
if result.get('feedback'):
    parts.append(result['feedback'])
strengths = result.get('strengths') or []
if strengths:
    parts.append('✅ ' + strengths[0])
improvements = (result.get('improvements') or [])[:2]
for imp in improvements:
    parts.append('▲ ' + imp)
parts.append("Reply again to improve your score, or wait for the next question.")
text = '\n\n'.join(parts)
if len(text) > 1500:
    text = text[:1500] + '…'
print(text)
PY
)" || {
  log "FAILED: could not parse evaluation output: $(echo "$RAW_EVAL" | head -c 200 | tr '\n' ' ')"
  send_imessage "⚠️ Got your answer but couldn't parse the evaluation — reply again to retry, or grade it from the dashboard."
  exit 0
}

send_imessage "$REPLY_TEXT"
log "Feedback sent."
