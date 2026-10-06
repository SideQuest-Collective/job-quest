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

# Narrow agent writes to scratch inside a workbook. The OS guard also covers
# relative ../ paths and symlink escapes; runtime state outside the workbook is
# still available to the CLI. Codex additionally uses workspace-write.
run_in_scratch() {
  cd "$WORK_DIR"
  if [[ "$(basename "$WORK_DIR")" =~ ^(drafts|research)$ ]] && [ -x /usr/bin/sandbox-exec ]; then
    local scratch workbook
    scratch="$(pwd -P)"
    workbook="$(cd .. && pwd -P)"
    /usr/bin/sandbox-exec -D "SCRATCH=$scratch" -D "WORKBOOK=$workbook" -p '(version 1) (allow default) (deny file-write* (require-all (subpath (param "WORKBOOK")) (require-not (subpath (param "SCRATCH")))))' "${CMD[@]}" < "$PROMPT_FILE"
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
