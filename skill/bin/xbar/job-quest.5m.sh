#!/bin/bash
# <xbar.title>Job Quest</xbar.title>
# <xbar.version>v1.0</xbar.version>
# <xbar.author>SideQuest Collective</xbar.author>
# <xbar.author.github>SideQuest-Collective</xbar.author.github>
# <xbar.desc>Monitor and manage your Job Quest dashboard from the menu bar.</xbar.desc>
# <xbar.image></xbar.image>
# <xbar.dependencies>bash,curl,node</xbar.dependencies>
# <xbar.abouturl>https://github.com/SideQuest-Collective/job-quest</xbar.abouturl>
#
# Refresh every 5 minutes (filename `.5m.`). xbar also re-runs on click.

set -u

PRODUCT_HOME="$HOME/.job-quest"
BIN_DIR="$PRODUCT_HOME/bin"
DATA_DIR="${DATA_DIR:-${JOB_QUEST_DATA_DIR:-$PRODUCT_HOME/data}}"
PORT="${JOB_QUEST_PORT:-${PORT:-3847}}"
BASE="http://localhost:$PORT"
PLUGIN_PATH="${0}"

# xbar actions must return immediately while the intel runtime works.
if [ "${1:-}" = "--refresh-intel" ]; then
  [ -x "$BIN_DIR/run-daily-intel.sh" ] || exit 1
  mkdir -p "$DATA_DIR/logs" || exit 1
  nohup "$BIN_DIR/run-daily-intel.sh" </dev/null >>"$DATA_DIR/logs/daily-intel.log" 2>&1 &
  disown
  exit 0
fi

# The bounded status request also probes connectivity: curl 7 means refused;
# timeouts, HTTP errors, and invalid responses mean the service is unresponsive.
CURL_STATUS=0
STATUS_JSON="$(curl -fsS --connect-timeout 1 --max-time 2 "$BASE/api/status" 2>/dev/null)" || {
  CURL_STATUS=$?
  STATUS_JSON=""
}

STATUS_OK= ROLES_TODAY= TASKS_DONE= TASKS_TOTAL= QUIZ_ANS= QUIZ_TOTAL=
QUIZ_CORRECT= STREAK= SAVED= APPLIED= INTEL_IS_TODAY= INTERVIEW_UNLINKED=

# Parse once with the dashboard's node dependency. Only fixed keys and typed
# metrics cross into the shell; read/printf assign values without evaluating them.
parse_status() {
  if ! command -v node >/dev/null 2>&1 && [ -f "$PRODUCT_HOME/app/lib/runtime-shell.sh" ]; then
    # Discover Homebrew/nvm node under xbar's minimal PATH, without loading runtime state.
    source "$PRODUCT_HOME/app/lib/runtime-shell.sh"
    job_quest_ensure_tool_path
  fi
  JQ_STATUS_JSON="$STATUS_JSON" node <<'JS' 2>/dev/null
try {
  const d = JSON.parse(process.env.JQ_STATUS_JSON);
  const fields = {
    STATUS_OK: d?.ok, ROLES_TODAY: d?.rolesToday,
    TASKS_DONE: d?.tasks?.done, TASKS_TOTAL: d?.tasks?.total,
    QUIZ_ANS: d?.quiz?.answered, QUIZ_TOTAL: d?.quiz?.total, QUIZ_CORRECT: d?.quiz?.correct,
    STREAK: d?.streak, SAVED: d?.roles?.saved, APPLIED: d?.roles?.applied,
    INTEL_IS_TODAY: d?.intelIsToday, INTERVIEW_UNLINKED: d?.interview?.unlinked,
  };
  for (const [key, value] of Object.entries(fields)) {
    const valid = key === 'STATUS_OK' || key === 'INTEL_IS_TODAY'
      ? typeof value === 'boolean' : Number.isSafeInteger(value) && value >= 0;
    console.log(`${key}=${valid ? value : ''}`);
  }
} catch {}
JS
}
while IFS='=' read -r key value; do
  case "$key" in
    STATUS_OK|ROLES_TODAY|TASKS_DONE|TASKS_TOTAL|QUIZ_ANS|QUIZ_TOTAL|QUIZ_CORRECT|STREAK|SAVED|APPLIED|INTEL_IS_TODAY|INTERVIEW_UNLINKED)
      printf -v "$key" '%s' "$value"
      ;;
  esac
done < <(parse_status)

SERVER_STATE=unresponsive
if [ "$CURL_STATUS" -eq 7 ]; then
  SERVER_STATE=stopped
elif [[ "$CURL_STATUS" -eq 0 && "$STATUS_OK" = true && "$ROLES_TODAY" =~ ^[0-9]+$ && "$TASKS_DONE" =~ ^[0-9]+$ && "$TASKS_TOTAL" =~ ^[0-9]+$ ]]; then
  SERVER_STATE=running
fi

[ -z "$ROLES_TODAY" ] && ROLES_TODAY=0
[ -z "$TASKS_DONE" ] && TASKS_DONE=0
[ -z "$TASKS_TOTAL" ] && TASKS_TOTAL=0
[ -z "$STREAK" ] && STREAK=0

# --- Menu bar title ---
if [ "$SERVER_STATE" = running ]; then
  echo "JQ 🎯 ${ROLES_TODAY} · ✓ ${TASKS_DONE}/${TASKS_TOTAL}"
elif [ "$SERVER_STATE" = unresponsive ]; then
  echo "JQ ⚠"
else
  echo "JQ ⏸"
fi

echo "---"

# --- Header ---
if [ "$SERVER_STATE" = running ]; then
  echo "Job Quest — Today | href=$BASE/ color=#1a73e8"
  if [ "$INTEL_IS_TODAY" = "True" ] || [ "$INTEL_IS_TODAY" = "true" ]; then
    echo "Fresh intel for today ✓ | color=#34a853"
  else
    echo "Intel not yet refreshed today | color=#f9ab00"
  fi
  echo "Streak: ${STREAK} day(s)"
  if [ -n "$QUIZ_TOTAL" ] && [ "$QUIZ_TOTAL" != "0" ] && [ -n "$QUIZ_ANS" ]; then
    echo "Quiz: ${QUIZ_ANS}/${QUIZ_TOTAL} answered · ${QUIZ_CORRECT:-0} correct"
  fi
  if [ -n "$SAVED" ] || [ -n "$APPLIED" ]; then
    echo "Roles: ${SAVED:-0} saved · ${APPLIED:-0} applied"
  fi
  if [[ "$INTERVIEW_UNLINKED" =~ ^[0-9]+$ ]] && [ "$INTERVIEW_UNLINKED" -gt 0 ]; then
    echo "Interview: ${INTERVIEW_UNLINKED} unlinked session(s) | href=$BASE/#workbooks"
  fi
elif [ "$SERVER_STATE" = unresponsive ]; then
  echo "Dashboard server is unresponsive | color=#f9ab00"
else
  echo "Dashboard server is not running | color=#d93025"
fi

echo "---"

# --- Open links ---
echo "Open Dashboard | href=$BASE/"
if [ "$SERVER_STATE" = running ]; then
  echo "Today's Intel | href=$BASE/#intel"
  echo "Daily Tasks | href=$BASE/#tasks"
  echo "Workbooks | href=$BASE/#workbooks"
  echo "Code Lab | href=$BASE/#codelab"
  echo "Trainer | href=$BASE/#trainer"
fi

echo "---"

# --- Server controls ---
if [ "$SERVER_STATE" != stopped ]; then
  if [ "$SERVER_STATE" = running ]; then
    echo "Server: Running ✓ | color=#34a853"
  else
    echo "Server: Unresponsive ⚠ | color=#f9ab00"
  fi
  echo "Stop Server | shell='$BIN_DIR/stop.sh' terminal=false refresh=true"
  echo "Restart Server | shell='$BIN_DIR/restart.sh' terminal=false refresh=true"
else
  echo "Server: Stopped ✗ | color=#d93025"
  if [ -x "$BIN_DIR/start.sh" ]; then
    echo "Start Server | shell='$BIN_DIR/start.sh' param1='--background' terminal=false refresh=true"
  fi
fi

# Refresh intel manually
if [ -x "$BIN_DIR/run-daily-intel.sh" ]; then
  echo "Refresh Intel Now | shell='$PLUGIN_PATH' param1='--refresh-intel' terminal=false refresh=true"
fi

echo "---"

# --- Logs / advanced ---
if [ -f "$DATA_DIR/logs/dashboard.log" ]; then
  echo "View Dashboard Log | shell='/usr/bin/open' param1='$DATA_DIR/logs/dashboard.log' terminal=false refresh=true"
fi

if [ -f "$DATA_DIR/logs/daily-intel.log" ]; then
  echo "View Intel Log | shell='/usr/bin/open' param1='-a' param2='Console' param3='$DATA_DIR/logs/daily-intel.log' terminal=false refresh=true"
fi

if [ -x "$BIN_DIR/install-xbar.sh" ]; then
  echo "Uninstall Menu Bar Plugin | shell='$BIN_DIR/install-xbar.sh' param1='--uninstall' terminal=false refresh=true"
fi

echo "Refresh now | refresh=true"
