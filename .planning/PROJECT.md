# Job Quest

## What This Is

Job Quest is a local job-search command center with a web dashboard, scheduled daily intel generation, and a conversational skill entrypoint. Today it is built around Claude-specific install paths, skill registration, and CLI invocations; this project is to make that experience work in Codex as well without breaking the existing Claude flow.

## Core Value

A job seeker can install Job Quest once and use the same core workflow from their chosen agent runtime without losing the local dashboard and automation that make the product useful.

## Requirements

### Validated

- ✓ Local dashboard for tracking intel, tasks, quizzes, applications, resume data, and coding practice exists in the current codebase — existing
- ✓ Claude-oriented onboarding and skill-driven job-search workflow are documented and partially implemented — existing
- ✓ Claude CLI-backed helpers for plan generation, code review, and scheduled intel generation exist in the current codebase — existing

### Active

- [ ] Support Codex as a first-class runtime alongside Claude
- [ ] Remove hard-coded Claude-only install and execution assumptions from scripts, prompts, and docs
- [ ] Keep the dashboard and local data model stable across supported runtimes
- [ ] Preserve existing Claude usage while introducing Codex-compatible setup and commands

### Out of Scope

- Supporting every AI coding runtime in the same milestone — the immediate target is Claude + Codex only
- Redesigning the dashboard UX — compatibility work should not turn into a frontend rewrite
- Expanding core job-search product scope unrelated to runtime compatibility — keep focus on compatibility and reliability

## Context

The repository already contains a working Express dashboard in `app/`, a Claude-oriented skill definition in `skill/SKILL.md`, install/uninstall scripts, and runtime helper scripts for AI-assisted workflows. The current implementation hard-codes Claude-specific conventions in many places, including `~/.claude/...` paths, `/job-quest` command references, and direct `claude` / `@anthropic-ai/claude-code` CLI usage.

The compatibility effort is brownfield rather than greenfield. Existing behavior around local JSON storage, scheduling, interview prep, code review, and daily intel generation needs to remain intact while the runtime-specific pieces are abstracted. The repo also needs a clearer separation between product logic and agent-runtime integration so future compatibility work does not require touching every script and document.

## Constraints

- **Compatibility**: Claude behavior must keep working while Codex support is added — the current user base and docs assume Claude already works
- **Local-first**: Data stays on the user's machine in the install directory — the dashboard and scheduled jobs depend on local filesystem access
- **Brownfield**: Existing file layout, scripts, and dashboard endpoints must be evolved rather than replaced wholesale — lower migration risk
- **Scope**: This milestone should center on runtime compatibility, packaging, and verification — avoid unrelated product expansion

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Treat the repo as a brownfield compatibility project, not a greenfield rebuild | The dashboard, data model, and Claude-oriented flows already exist and should be preserved | — Pending |
| Make dual-runtime support the current milestone focus | The user explicitly wants Codex compatibility in addition to the current Claude setup | — Pending |
| Prioritize runtime abstraction at install/script/skill boundaries before feature work | Most compatibility risk comes from hard-coded paths and runtime-specific commands | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check -> still the right priority?
3. Audit Out of Scope -> reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-21 after initialization*
