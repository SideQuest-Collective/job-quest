#!/bin/bash
# Run one specialist agent with per-profile tool limits.
# Usage: run-agent.sh <profile> <prompt-file> <cwd>
# Profiles: research (web + write), write (read + write/edit), edit (read + edit), read (read only)

set -euo pipefail

PROFILE="${1:?profile}"
PROMPT_FILE="${2:?prompt file}"
WORK_DIR="${3:?cwd}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/../app/lib/runtime-shell.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../app" && pwd)"
else
  echo "Job Quest runtime helpers not found" >&2
  exit 1
fi

if [ -n "${JOB_QUEST_AGENT_RUNTIME_OVERRIDE:-}" ]; then
  JOB_QUEST_ACTIVE_RUNTIME="$JOB_QUEST_AGENT_RUNTIME_OVERRIDE"
  JOB_QUEST_RUNTIME_COMMAND="${JOB_QUEST_RUNTIME_COMMAND:-$JOB_QUEST_AGENT_RUNTIME_OVERRIDE}"
  if [ "$JOB_QUEST_ACTIVE_RUNTIME" = "codex" ]; then JOB_QUEST_RUNTIME_COMMAND_ARGS=(exec); else JOB_QUEST_RUNTIME_COMMAND_ARGS=(--print); fi
else
  # shellcheck disable=SC1090
  source "$REPO_ROOT/lib/runtime-shell.sh"
  JOB_QUEST_REPO_ROOT="$REPO_ROOT"
  job_quest_load_runtime --require-registration
fi

# Narrow agent writes to their scratch directory inside workbook/interview work.
# The OS guard covers relative ../ paths and symlink escapes; runtime state
# outside the fenced root remains available. Codex also uses workspace-write.
run_in_scratch() {
  local scratch fence_root="" interview_root=""
  if [ -n "${DATA_DIR:-}" ] && [ -d "$DATA_DIR/interview-work" ]; then
    interview_root="$(cd "$DATA_DIR/interview-work" && pwd -P)"
  fi
  cd "$WORK_DIR"
  scratch="$(pwd -P)"
  if [[ "$scratch" =~ ^(.*/interview-work)/(cheatsheets|sessions)/[^/]+$ ]]; then
    # CLI callers may not export DATA_DIR; the canonical cwd identifies its root.
    fence_root="${BASH_REMATCH[1]}"
  elif [ -n "$interview_root" ] && [[ "$scratch" == "$interview_root/"* ]]; then
    fence_root="$interview_root"
  elif [[ "$(basename "$WORK_DIR")" =~ ^(drafts|research)$ ]]; then
    fence_root="$(cd .. && pwd -P)"
  fi
  if [ -n "$fence_root" ] && [ -x /usr/bin/sandbox-exec ]; then
    /usr/bin/sandbox-exec -D "SCRATCH=$scratch" -D "FENCE_ROOT=$fence_root" -p '(version 1) (allow default) (deny file-write* (require-all (subpath (param "FENCE_ROOT")) (require-not (subpath (param "SCRATCH")))))' "${CMD[@]}" < "$PROMPT_FILE"
  else
    "${CMD[@]}" < "$PROMPT_FILE"
  fi
}

if [ "${JOB_QUEST_ACTIVE_RUNTIME:-claude}" = "codex" ]; then
  case "$PROFILE" in
    research) FLAGS=(--sandbox workspace-write -c tools.web_search=true) ;;
    write|edit) FLAGS=(--sandbox workspace-write) ;;
    *) FLAGS=(--sandbox read-only) ;;
  esac
  CMD=("${JOB_QUEST_RUNTIME_COMMAND}" "${JOB_QUEST_RUNTIME_COMMAND_ARGS[@]}" -C "$WORK_DIR" --skip-git-repo-check "${FLAGS[@]}")
  if [ "${JOB_QUEST_RUNTIME_DRY_RUN:-0}" = "1" ]; then printf '%q ' "${CMD[@]}"; echo; exit 0; fi
  run_in_scratch
else
  case "$PROFILE" in
    research) TOOLS="Write,WebSearch,WebFetch" ;;
    write) TOOLS="Read,Write,Edit,Glob,Grep" ;;
    edit) TOOLS="Read,Edit,Glob,Grep" ;;
    *) TOOLS="Read,Glob,Grep" ;;
  esac
  CMD=("${JOB_QUEST_RUNTIME_COMMAND}" "${JOB_QUEST_RUNTIME_COMMAND_ARGS[@]}" --allowed-tools "$TOOLS" --add-dir "$WORK_DIR" --permission-mode acceptEdits)
  if [ "${JOB_QUEST_RUNTIME_DRY_RUN:-0}" = "1" ]; then printf '%q ' "${CMD[@]}"; echo; exit 0; fi
  run_in_scratch
fi
