#!/bin/bash
# Shared listener-scoped shutdown for dashboard controls and uninstall.

stop_dashboard_server() {
  local pids pid comm attempt remaining_pids term_pids=" "
  local port="${JOB_QUEST_PORT:-${PORT:-3847}}"
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  [ -n "$pids" ] || return 0

  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    if [ "${comm##*/}" = node ]; then
      kill "$pid" 2>/dev/null || true
      term_pids+="$pid "
    fi
  done <<< "$pids"
  [ "$term_pids" != " " ] || return 0

  # Allow listeners time to exit, without waiting indefinitely on another app.
  for attempt in 1 2 3 4 5; do
    [ -n "$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)" ] || return 0
    sleep 1
  done

  # Force-stop only original TERM targets that are still listening as node.
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    if [ "${comm##*/}" = node ] && [[ "$term_pids" == *" $pid "* ]]; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done <<< "$pids"

  # SIGKILL can precede socket release. Wait briefly, then report surviving
  # original node targets without treating another app's listener as failure.
  for attempt in 0 1 2 3 4 5; do
    remaining_pids=""
    pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      [[ "$term_pids" == *" $pid "* ]] || continue
      comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
      if [ "${comm##*/}" = node ]; then
        remaining_pids+="$pid "
      fi
    done <<< "$pids"
    [ -n "$remaining_pids" ] || return 0
    if [ "$attempt" = 5 ]; then
      for pid in $remaining_pids; do
        echo "Error: dashboard listener $pid did not exit." >&2
      done
      return 1
    fi
    sleep 1
  done
}
