# Phase 2: Dual-Runtime Install Surface - Context

**Gathered:** 2026-04-22
**Status:** Complete

<domain>
## Phase Boundary

Move Job Quest from the Claude-root install model to a shared `~/.job-quest` home while keeping runtime-native skill registration for Claude and Codex.

</domain>

<decisions>
## Implementation Decisions

### Install layout
- Canonical shared home is `~/.job-quest`.
- Repo checkout lives in `~/.job-quest/app`.
- Mutable user state lives in `~/.job-quest/data`.

### Registration
- Install both Claude and Codex skill registrations so runtime switching does not require reinstall.
- Keep `~/.claude/job-quest` as a compatibility shim when it is safe to create.

### Lifecycle behavior
- Uninstall/reinstall own both runtime registration directories.
- `--keep-data` preserves shared user state under `~/.job-quest/data`.

</decisions>
