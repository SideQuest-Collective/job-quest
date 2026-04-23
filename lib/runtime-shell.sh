#!/bin/bash

set -euo pipefail

job_quest_repo_root() {
  local source_dir
  source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$source_dir/.." && pwd
}

job_quest_system_home() {
  if [ -n "${JOB_QUEST_SYSTEM_HOME:-}" ]; then
    printf '%s\n' "$JOB_QUEST_SYSTEM_HOME"
    return
  fi

  local detected_home=""
  if command -v python3 >/dev/null 2>&1; then
    detected_home="$(python3 - <<'PY'
import os
import pwd

print(pwd.getpwuid(os.getuid()).pw_dir)
PY
)"
  fi

  if [ -z "$detected_home" ]; then
    detected_home="${HOME:-}"
  fi

  printf '%s\n' "$detected_home"
}

job_quest_apply_runtime_env() {
  export JOB_QUEST_SYSTEM_HOME="${JOB_QUEST_SYSTEM_HOME:-$(job_quest_system_home)}"

  # Codex auth/config lives under the real user home even when HOME is repointed
  # so Job Quest can install into a workspace-scoped product directory.
  if [ "${JOB_QUEST_ACTIVE_RUNTIME:-claude}" = "codex" ] && [ -z "${CODEX_HOME:-}" ]; then
    export CODEX_HOME="$JOB_QUEST_SYSTEM_HOME/.codex"
  fi
}

job_quest_load_runtime() {
  local repo_root
  repo_root="${JOB_QUEST_REPO_ROOT:-$(job_quest_repo_root)}"
  # shellcheck disable=SC1090
  eval "$(node "$repo_root/lib/runtime.js" shell --require-runner "$@")"
  job_quest_apply_runtime_env
}

job_quest_runtime_hint() {
  local runtime="${JOB_QUEST_ACTIVE_RUNTIME:-unknown}"
  local display="${JOB_QUEST_RUNTIME_DISPLAY_NAME:-runtime}"
  echo "${display} (${runtime})"
}

job_quest_install_hint() {
  case "${JOB_QUEST_ACTIVE_RUNTIME:-claude}" in
    codex)
      echo "Install Codex CLI and make sure \`codex\` is on PATH."
      ;;
    *)
      echo "Install Claude Code CLI and make sure \`claude\` is on PATH."
      ;;
  esac
}

job_quest_run_prompt_file() {
  local prompt_file="$1"
  shift

  if [ ! -f "$prompt_file" ]; then
    echo "Prompt file not found: $prompt_file" >&2
    return 1
  fi

  if [ "${JOB_QUEST_ACTIVE_RUNTIME:-claude}" = "codex" ]; then
    local codex_cmd=(
      "${JOB_QUEST_RUNTIME_COMMAND}"
      "${JOB_QUEST_RUNTIME_COMMAND_ARGS[@]}"
      -C "${JOB_QUEST_APP_ROOT}"
      --skip-git-repo-check
    )

    if [ -n "${JOB_QUEST_DATA_DIR:-}" ] && [ -d "${JOB_QUEST_DATA_DIR}" ]; then
      codex_cmd+=(--add-dir "${JOB_QUEST_DATA_DIR}")
    fi

    "${codex_cmd[@]}" "$@" < "$prompt_file"
  else
    cat "$prompt_file" | "${JOB_QUEST_RUNTIME_COMMAND}" "${JOB_QUEST_RUNTIME_COMMAND_ARGS[@]}" "$@"
  fi
}
