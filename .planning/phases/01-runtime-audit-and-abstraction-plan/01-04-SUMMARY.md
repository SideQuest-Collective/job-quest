---
phase: 01-runtime-audit-and-abstraction-plan
plan: 04
subsystem: infra
tags: [runtime-contract, migration, config, claude, codex, docs]
requires:
  - phase: 01-02
    provides: shared runtime contract, migration baseline, and config example that this plan reconciles
provides:
  - one shared activation order across the runtime contract and migration guide
  - one deferred-path rule for canonical and last-known-good product roots
  - one persisted runtimeValidation schema in docs and config example
affects: [phase-02-dual-runtime-install-surface, phase-03-runtime-aware-ai-execution, phase-05-documentation-and-validation]
tech-stack:
  added: []
  patterns: [detect-validate-activate runtime bootstrap, deferred migration with last-known-good root]
key-files:
  created: [.planning/phases/01-runtime-audit-and-abstraction-plan/01-04-SUMMARY.md]
  modified: [docs/runtime/runtime-contract.md, docs/runtime/runtime-migration.md, docs/runtime/runtime-config-example.json]
key-decisions:
  - "Bootstrap and later invocations record `detectedRuntime` immediately, validate readiness, and write `activeRuntime` only after validation succeeds."
  - "When `migrationState=deferred`, `productHomeDir` stays on the last-known-good root and `pendingCanonicalHomeDir` remains `~/.job-quest`."
  - "Persist runtime readiness diagnostics in one top-level `runtimeValidation` object with fixed child keys."
patterns-established:
  - "Runtime switch pattern: detect the invoking runtime, validate it in non-interactive environments, then persist the active runtime."
  - "Deferred migration pattern: preserve continuity on the last-known-good root while keeping the canonical target explicit."
requirements-completed: [RT-03]
duration: 10m
completed: 2026-04-23
---

# Phase 01 Plan 04: Runtime Semantics Reconciliation Summary

**Unified runtime bootstrap order, deferred migration behavior, and persisted validation diagnostics across the contract, migration guide, and runtime config example**

## Performance

- **Duration:** 10m
- **Started:** 2026-04-23T01:17:00Z
- **Completed:** 2026-04-23T01:27:16Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Updated the runtime contract so it documents one top-level `runtimeValidation` object with the required child keys and one consistent detect-validate-activate bootstrap order.
- Rewrote the migration guide so deferred migrations stay on the last-known-good root, keep `pendingCanonicalHomeDir=~/.job-quest`, and persist readiness failures in `runtimeValidation`.
- Extended the runtime config example with the same persisted diagnostics field while keeping the example on the `migrationState: "ready"` happy path.

## Verification Results

- `rg -n 'runtimeValidation|lastCheckedRuntime|lastFailureReason|migrationState=deferred|last-known-good root|pendingCanonicalHomeDir=~/.job-quest' docs/runtime/runtime-contract.md` — PASS
- `rg -n 'runtimeValidation|detectedRuntime|activeRuntime|last-known-good root|pendingCanonicalHomeDir=~/.job-quest' docs/runtime/runtime-migration.md` — PASS
- `rg -n '"runtimeValidation"|"lastCheckedRuntime"|"lastFailureReason"|"migrationState": "ready"' docs/runtime/runtime-config-example.json` — PASS
- `node -e "JSON.parse(require('fs').readFileSync('docs/runtime/runtime-config-example.json','utf8')); console.log('json-ok')"` — PASS (`json-ok`)

## Task Commits

Each task was committed atomically:

1. **Task 1: Reconcile the runtime contract with the deferred-migration and validation rules** - `6d2e2bd` (docs)
2. **Task 2: Rewrite the migration guide to use the same bootstrap and deferred-path semantics as the contract** - `83100c3` (docs)
3. **Task 3: Extend the runtime config example with the documented validation diagnostics field** - `76b634e` (docs)

## Files Created/Modified

- `docs/runtime/runtime-contract.md` - adds the persisted `runtimeValidation` schema and aligns contract language with the verifier's target activation and deferred-path semantics
- `docs/runtime/runtime-migration.md` - aligns bootstrap, automatic runtime switching, and deferred migration behavior with the contract
- `docs/runtime/runtime-config-example.json` - shows the ready-state example with persisted runtime validation diagnostics
- `.planning/phases/01-runtime-audit-and-abstraction-plan/01-04-SUMMARY.md` - records execution, verification, and handoff context for this plan

## Decisions Made

- Standardized one activation order everywhere: record `detectedRuntime`, validate readiness, then persist `activeRuntime`.
- Standardized one deferred-path rule everywhere: hold `productHomeDir` on the last-known-good root while `migrationState=deferred`, with `pendingCanonicalHomeDir=~/.job-quest`.
- Standardized one persisted diagnostics location everywhere: `runtimeValidation` in `runtime.json`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- A transient `.git/index.lock` blocked the Task 3 commit once. The lock cleared before remediation was needed, and the retry succeeded without changing plan scope or outputs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 2 can now implement install-time bootstrap and runtime registration against one unambiguous activation order and deferred-path rule.
- Phase 3 can persist and consume the documented `runtimeValidation` object without inventing new schema.
- No blocker remains in these three runtime docs for downstream implementation planning.

## Self-Check

PASSED

- Verified `.planning/phases/01-runtime-audit-and-abstraction-plan/01-04-SUMMARY.md` exists.
- Verified `docs/runtime/runtime-contract.md` exists.
- Verified `docs/runtime/runtime-migration.md` exists.
- Verified `docs/runtime/runtime-config-example.json` exists.
- Verified task commits `6d2e2bd`, `83100c3`, and `76b634e` exist in git history.

---
*Phase: 01-runtime-audit-and-abstraction-plan*
*Completed: 2026-04-23*
