# Job Quest

Job Quest is a local job-search command center with a web dashboard, scheduled daily intel generation, and a conversational skill entrypoint. It now supports both Claude and Codex while keeping one shared local install and one shared data footprint.

## What You Get

- Daily intel generation with roles, quizzes, tasks, and adaptive coding problems
- A local dashboard at `http://localhost:3847`
- Helper scripts for interview-plan generation, code review, scheduling, uninstall, and reinstall
- Automatic skill-start update checks backed by a non-destructive local updater
- Runtime-aware skill registration for Claude and Codex backed by the same shared install

## Install

```bash
curl -sL https://raw.githubusercontent.com/SideQuest-Collective/job-quest/main/install.sh | bash
```

The installer creates a shared home at `~/.job-quest/`, installs the repo under `~/.job-quest/app/`, writes runtime config to `~/.job-quest/config/runtime.json`, and registers `job-quest` in:

- `~/.claude/skills/job-quest/SKILL.md`
- `~/.codex/skills/job-quest/SKILL.md`

The active runtime defaults to the CLI that ran the installer and can switch later without reinstall.

## Shared Layout

```text
~/.job-quest/
├── app/           # repo checkout
├── bin/           # installed helper scripts
├── config/        # runtime.json
├── data/          # local user data and generated artifacts
└── references/    # shared prompt/reference files
```

Mutable state lives under `~/.job-quest/data/`, including:

- `profile.json`
- `intel/`
- `quizzes/`
- `tasks/`
- `problems/`
- `behavioral/`
- `conversations/`
- `sd-conversations/`
- `resume-files/`
- `logs/`

## Runtime Behavior

Job Quest keeps one shared install and one shared data tree, while runtime-specific registration stays native to each assistant. Runtime selection and command resolution live in `~/.job-quest/config/runtime.json`.

- Claude uses the configured Claude CLI candidate
- Codex uses `codex exec`
- Helper scripts and the dashboard server read the active runtime from the shared runtime descriptor instead of probing Claude-only paths

## Dashboard

Start the dashboard with:

```bash
~/.job-quest/bin/start.sh
```

The server reads data from `~/.job-quest/data/`.

## Helper Scripts

The installer writes these scripts to `~/.job-quest/bin/`:

- `start.sh` — start the dashboard
- `generate-plan.sh` — runtime-aware interview-plan and evaluation generation
- `code-review.sh` — runtime-aware conversational review/edit wrapper
- `run-daily-intel.sh` — generate today’s intel batch
- `configure-local.cjs` — connect optional local review files, interview home, and private-access settings
- `update.sh` — fetch remote changes and refresh the local install when behind
- `install-schedule.sh` — install or inspect the local schedule
- `uninstall.sh` — remove Job Quest
- `reinstall.sh` — uninstall then reinstall

The `job-quest` skill can inspect update status with:

```bash
~/.job-quest/bin/update.sh --check-only
```

The skill preserves local changes and existing review schedules. A native daily-intel schedule is optional when another career review already supplies the local brief. See [Local setup](LOCAL-SETUP.md) for optional connections.

## Scheduling

Install a weekday schedule:

```bash
~/.job-quest/bin/install-schedule.sh "3 7 * * 1-5"

# Check whether any schedule exists
~/.job-quest/bin/install-schedule.sh --exists

# Print the current cron expression
~/.job-quest/bin/install-schedule.sh --current-cron

# Change the schedule time later
~/.job-quest/bin/install-schedule.sh "30 8 * * 1-5"
```

On macOS this uses `launchd` by default. On Linux it uses `crontab`.

## Requirements

- Node.js 18+
- Git
- One supported runtime CLI:
  - Claude Code CLI, or
  - Codex CLI

Optional:

- Python 3 for the coding sandbox
- `tectonic` for LaTeX resume compilation

## Uninstall / Reinstall

```bash
bash ~/.job-quest/bin/uninstall.sh
bash ~/.job-quest/bin/uninstall.sh --keep-data
bash ~/.job-quest/bin/reinstall.sh
bash ~/.job-quest/bin/reinstall.sh --keep-data
```

## Runtime Docs

- [Runtime contract](docs/runtime/runtime-contract.md)
- [Migration strategy](docs/runtime/runtime-migration.md)
- [Coupling audit](docs/runtime/runtime-coupling-audit.md)

## License

MIT
