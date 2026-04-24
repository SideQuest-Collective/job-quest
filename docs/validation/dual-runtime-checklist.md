# Dual-Runtime Validation Checklist

Use this checklist after install or before release to verify Job Quest still works end-to-end in both supported runtimes.

## Shared Install Checks

1. Run the installer.

```bash
curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash
```

2. Confirm the shared home exists.

```bash
test -d ~/.job-quest/app
test -d ~/.job-quest/data
test -d ~/.job-quest/bin
test -f ~/.job-quest/config/runtime.json
```

3. Confirm both runtime registrations exist.

```bash
test -f ~/.claude/skills/job-quest/SKILL.md
test -f ~/.codex/skills/job-quest/SKILL.md
```

## Runtime Config Checks

1. Inspect the runtime descriptor.

```bash
cat ~/.job-quest/config/runtime.json
```

2. Verify these fields are present and coherent:

- `activeRuntime`
- `detectedRuntime`
- `productHomeDir`
- `dataDir`
- `binDir`
- `runtimeCommand`
- `runtimeCommandArgs`
- `supportedRuntimes`

## Dashboard Checks

1. Start the dashboard.

```bash
~/.job-quest/bin/start.sh
```

2. Confirm:

- The server starts without a Claude-only path error
- The dashboard loads at `http://localhost:3847`
- `/api/runtime` returns the active runtime metadata
- `/api/job-status` returns a runtime-aware schedule command hint

## Helper Script Checks

Run each helper at least once in an installed environment:

```bash
~/.job-quest/bin/install-schedule.sh --show
echo "Review this solution." | ~/.job-quest/bin/code-review.sh
~/.job-quest/bin/generate-plan.sh /tmp/job-quest-prompt.txt
~/.job-quest/bin/run-daily-intel.sh
```

Expected outcomes:

- Each script resolves paths from `~/.job-quest`
- Runtime failures mention the active runtime command instead of Claude-only text
- Daily intel writes JSON files into `~/.job-quest/data/`
- For Codex, `~/.job-quest/bin/run-daily-intel.sh` should complete without a product-home access error and should refresh `~/.job-quest/data/intel/`, `~/.job-quest/data/quizzes/`, and `~/.job-quest/data/tasks/` for the same local day

## Claude Flow

1. Invoke Job Quest from Claude.
2. Confirm Claude uses the shared install rather than creating a second product home.
3. Confirm `runtime.json` keeps or switches `activeRuntime` to `claude` when Claude is the validated invoking runtime.

## Codex Flow

1. Invoke Job Quest from Codex.
2. Confirm Codex uses the same shared install and data tree.
3. Confirm `runtime.json` keeps or switches `activeRuntime` to `codex` when Codex is the validated invoking runtime.

## Local-Date Checks

Verify the dashboard endpoints agree on the same local-day artifact selection:

```bash
curl -s http://localhost:3847/api/job-status
curl -s http://localhost:3847/api/intel/latest
curl -s http://localhost:3847/api/quizzes/today
curl -s http://localhost:3847/api/tasks/today
```

Expected outcomes:

- `/api/job-status`, `/api/intel/latest`, `/api/quizzes/today`, and `/api/tasks/today` point at the same local-day files when today's artifacts exist
- If today's intel file is missing, `/api/intel/latest` falls back to the newest available artifact without changing the local-day contract used by `/api/job-status`
- Check these endpoints near local day boundaries to confirm the server is not drifting to UTC-based "tomorrow" or "yesterday"

## Lifecycle Checks

Verify uninstall and reinstall behavior:

```bash
~/.job-quest/bin/uninstall.sh --keep-data --yes
~/.job-quest/bin/reinstall.sh --keep-data --yes
```

Expected outcomes:

- Shared data survives when `--keep-data` is used
- Runtime registration artifacts are recreated on reinstall
- No stale schedule entry is left behind
