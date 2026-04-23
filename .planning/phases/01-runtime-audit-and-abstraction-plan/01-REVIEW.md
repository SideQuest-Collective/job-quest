---
phase: 01-runtime-audit-and-abstraction-plan
reviewed: 2026-04-23T00:37:16Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - docs/runtime/runtime-coupling-audit.md
  - docs/runtime/runtime-contract.md
  - docs/runtime/runtime-config-example.json
  - docs/runtime/runtime-migration.md
findings:
  critical: 0
  warning: 3
  info: 0
  total: 3
status: issues_found
---
# Phase 01: Code Review Report

**Reviewed:** 2026-04-23T00:37:16Z
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed the runtime coupling audit, runtime contract, config example, and migration strategy. The coupling audit is consistent with the current repo state, but the contract and migration docs disagree on first-bootstrap behavior, and the schema is missing fields for diagnostics that the migration strategy requires.

## Warnings

### WR-01: First-bootstrap activation order is inconsistent

**File:** `docs/runtime/runtime-contract.md:103-108`, `docs/runtime/runtime-migration.md:39-40`
**Issue:** The contract says first bootstrap immediately sets both `detectedRuntime` and `activeRuntime`, while the migration strategy says `activeRuntime` should only be initialized after the selected runtime passes validation. Those are different behaviors. If Phase 2 follows the contract literally, it can persist an unusable runtime before background-safe validation finishes.
**Fix:**
```md
1. On first bootstrap, set `detectedRuntime` from the invoking runtime.
2. Validate the runtime command and registration artifact for background and interactive flows.
3. Only after validation succeeds, set `activeRuntime` and the resolved runtime-specific fields.
4. If validation fails, keep the last-known-good runtime active and surface a recoverable warning.
```

### WR-02: Deferred migration path conflicts with the "always use ~/.job-quest" rule

**File:** `docs/runtime/runtime-contract.md:80-87`, `docs/runtime/runtime-contract.md:103-105`, `docs/runtime/runtime-migration.md:38-39`, `docs/runtime/runtime-migration.md:63-65`
**Issue:** The runtime contract's switch semantics say the initial descriptor always points product paths at `~/.job-quest/...`, but both the contract's path rules and the migration strategy allow `migrationState=deferred` to keep `productHomeDir` on the last-known-good root for a run. That contradiction removes the escape hatch the migration document depends on when legacy and canonical data conflict.
**Fix:**
```md
2. The initial runtime descriptor points at `~/.job-quest/...` unless `migrationState=deferred`, in which case `productHomeDir` and the derived paths remain on the documented last-known-good root for that run.
```

### WR-03: Required runtime-switch diagnostics have no schema field

**File:** `docs/runtime/runtime-contract.md:39-61`, `docs/runtime/runtime-migration.md:73-77`
**Issue:** The migration strategy requires failed readiness checks to be "recorded for diagnostics", but the runtime descriptor schema defines no field for validation status, failure reason, or timestamp. Later phases will either invent side-channel files or silently skip the required diagnostics, which undermines the goal of having one exact shared contract.
**Fix:**
```json
"lastRuntimeValidation": {
  "runtime": "codex",
  "status": "failed",
  "checkedAt": "2026-04-23T00:37:16Z",
  "message": "registration artifact missing"
}
```

If diagnostics should live somewhere other than `runtime.json`, state that explicitly in the contract and remove the persistence requirement from the migration strategy.

---

_Reviewed: 2026-04-23T00:37:16Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
