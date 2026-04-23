---
phase: 01-runtime-audit-and-abstraction-plan
plan: 02
subsystem: infra
tags: [runtime-contract, migration, claude, codex, docs]
requires:
  - phase: 01-01
    provides: source-linked runtime coupling audit for install, wrapper, scheduler, server, and UI seams
provides:
  - shared runtime config contract with exact path, command, and switch fields
  - machine-readable Claude and Codex runtime config example
  - shared-home migration rules for legacy Claude installs and automatic runtime switching
affects: [phase-02-dual-runtime-install-surface, phase-03-runtime-aware-ai-execution, phase-04-product-integration-hardening, phase-05-documentation-and-validation]
tech-stack:
  added: []
  patterns: [single runtime descriptor, shared-home migration contract]
key-files:
  created: [docs/runtime/runtime-contract.md, docs/runtime/runtime-config-example.json, docs/runtime/runtime-migration.md, .planning/phases/01-runtime-audit-and-abstraction-plan/01-02-SUMMARY.md]
  modified: []
key-decisions:
  - "Use `~/.job-quest/` as the canonical shared product home while keeping runtime registration artifacts in runtime-native directories."
  - "Persist runtime switches on invocation so later Claude or Codex entry updates `activeRuntime` without reinstall."
patterns-established:
  - "Runtime descriptor pattern: later phases read one config shape for resolved paths, runtime commands, and registration metadata."
  - "Migration-first compatibility pattern: treat `~/.claude/job-quest` as legacy input while moving canonical ownership to the shared home."
requirements-completed: [RT-03]
duration: 1m 24s
completed: 2026-04-23
---

# Phase 01 Plan 02: Runtime Contract Summary

**Shared runtime contract, concrete config example, and migration rules for moving Job Quest from `~/.claude/job-quest` to one `~/.job-quest/` home across Claude and Codex**

## Performance

- **Duration:** 1m 24s
- **Started:** 2026-04-22T20:13:55-04:00
- **Completed:** 2026-04-22T20:15:19-04:00
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Created `docs/runtime/runtime-contract.md` with the required shared-home layout, exact runtime descriptor keys, and path/command/switch semantics.
- Added `docs/runtime/runtime-config-example.json` showing one shared `~/.job-quest` install with Claude and Codex registration metadata.
- Defined `docs/runtime/runtime-migration.md` so legacy `~/.claude/job-quest` installs are explicit migration sources and runtime switching persists without reinstall.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write the shared runtime contract** - `3c1bfa4` (docs)
2. **Task 2: Add a machine-readable runtime config example** - `531e004` (docs)
3. **Task 3: Define migration and automatic runtime-switch rules** - `2a9bce9` (docs)

## Files Created/Modified

- `docs/runtime/runtime-contract.md` - canonical shared-home layout, exact config keys, and consumer rules
- `docs/runtime/runtime-config-example.json` - concrete runtime descriptor example for Claude and Codex
- `docs/runtime/runtime-migration.md` - legacy Claude migration path, bootstrap rules, and switch persistence
- `.planning/phases/01-runtime-audit-and-abstraction-plan/01-02-SUMMARY.md` - execution summary and downstream handoff

## Decisions Made

- Standardized the canonical shared product home as `~/.job-quest/` with separate `app/`, `data/`, `bin/`, `references/`, and `config/runtime.json` ownership.
- Kept runtime-native registration paths outside the shared home so Claude and Codex can coexist without duplicating the product install.
- Defined `persist-on-invoke` as the required runtime switch policy so invocation from the other supported runtime updates `activeRuntime` immediately.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 2 can implement install-time bootstrap and registration changes against one fixed config shape instead of inventing new keys.
- Phase 3 has explicit command-resolution and runtime-switch semantics for helper wrappers and scheduled jobs.
- Phase 4 and Phase 5 can remove legacy Claude-root wording and document migration without redefining the shared-home model.

## Self-Check: PASSED

- Verified `docs/runtime/runtime-contract.md` exists.
- Verified `docs/runtime/runtime-config-example.json` exists.
- Verified `docs/runtime/runtime-migration.md` exists.
- Verified `.planning/phases/01-runtime-audit-and-abstraction-plan/01-02-SUMMARY.md` exists.
- Verified task commits `3c1bfa4`, `531e004`, and `2a9bce9` exist in git history.

---
*Phase: 01-runtime-audit-and-abstraction-plan*
*Completed: 2026-04-23*
