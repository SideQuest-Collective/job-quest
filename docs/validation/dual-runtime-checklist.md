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
# Claude: the plugin is installed (or, in the fallback case, the legacy skill copy exists)
claude plugin list | grep -q 'job-quest@job-quest-local' || test -f ~/.claude/skills/job-quest/SKILL.md
test -f ~/.codex/skills/job-quest/SKILL.md
```

When the `claude` CLI is available, `claude plugin list` should show `job-quest@job-quest-local` and `~/.claude/skills/job-quest` should not exist.

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

## Schedule Command Walkthrough (/job-quest:schedule)

The command is a prompt, so no automated test can run it. Walk through it by hand in Claude Code and check the state after each step:

1. Remove the daily intel schedule outside Claude (`~/.job-quest/bin/install-schedule.sh --uninstall`) and make sure `~/.job-quest/data/intel-schedule-preference.json` does not say frequency `off`. Start a new session: the SessionStart note says the daily intel schedule is missing and names `/job-quest:schedule`. Nothing was installed: `~/.job-quest/bin/install-schedule.sh --exists` still exits 1.
2. Type `/job-quest:schedule intel off` and confirm. Then `~/.job-quest/bin/install-schedule.sh --exists` exits 1 and `~/.job-quest/data/intel-schedule-preference.json` has frequency `off`, with `time` and `cron` null. Start a new session: no note.
3. Type `/job-quest:schedule intel` and choose weekdays at 07:03. Then `~/.job-quest/bin/install-schedule.sh --exists` exits 0 and the preference has frequency `weekdays` (or `daily`, if chosen), `time` `07:03` and `cron` `3 7 * * 1-5` (`3 7 * * *` for daily).
4. Put `"schedule": "external"` in `~/.job-quest/data/local-setup.json` and remove the schedule again. `/job-quest:schedule` says a missing native schedule is expected and asks before installing one. A new session shows no note.
5. Replace the preference file with invalid JSON. `/job-quest:schedule` reports it as unreadable and leaves it byte for byte as it was; a new session (with no schedule installed) shows the "status unknown" note, not "missing".
6. Type `/job-quest:schedule trainer 9-21`. Then `~/.job-quest/bin/install-trainer-schedule.sh --exists` exits 0 and `~/.job-quest/data/trainer/config.json` has `startHour` 9 and `endHour` 21, with its other keys unchanged.
7. Type `/job-quest:schedule podcast 08:30`. Then `~/.job-quest/bin/install-podcast-schedule.sh --exists` exits 0. Remove it with `/job-quest:schedule podcast off`: `--exists` exits 1.

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
