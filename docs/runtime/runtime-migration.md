# Runtime Migration Strategy

This document defines how Job Quest moves from the current Claude-root install model documented in [runtime-coupling-audit.md](./runtime-coupling-audit.md) to the shared runtime contract in [runtime-contract.md](./runtime-contract.md). It exists to preserve current Claude behavior while making `~/.job-quest/` the canonical product home for both Claude and Codex.

## Legacy Claude Install Detection

Legacy Claude installs are migration sources, not unsupported states.

Detection inputs:

- Product files or user data under `~/.claude/job-quest`
- Claude registration artifacts under `~/.claude/skills/job-quest`
- Existing helper scripts or schedule flows that still resolve `~/.claude/job-quest/bin/...`
- Existing launchd state for `com.sidequest.job-quest.daily-intel`

When any of those inputs exist, bootstrap must treat `~/.claude/job-quest` as the source to inspect and migrate into the canonical shared home at `~/.job-quest/`.

## No-Breakage Rules

1. Existing Claude users must keep working during and after migration.
2. The canonical product home becomes `~/.job-quest/`, but legacy `~/.claude/job-quest` content remains readable until the shared-home bootstrap finishes.
3. Migration must preserve one shared user-state footprint; it must not create separate Claude and Codex data trees.
4. Runtime-native registration artifacts may differ by runtime, but they must all point to the same `~/.job-quest/` install and `~/.job-quest/data/` state.
5. Scheduler behavior, dashboard data reads, and helper scripts must continue to resolve valid files after migration.
6. A later runtime change must update the persisted default without reinstall.
7. Uninstall and reinstall flows must treat the legacy Claude path as cleanup or import input, not as the canonical destination for fresh installs.
8. If migration detects conflicting writable state, normal product startup must continue against the last-known-good root while migration is deferred and surfaced as a warning.

## Bootstrap Behavior

Bootstrap owns first-run detection and migration into the shared home.

Required behavior:

1. Infer the current runtime from the invoking CLI or runtime registration surface.
2. If no legacy install exists, create `~/.job-quest/` directly using the directory layout in `runtime-contract.md`.
3. If `~/.claude/job-quest` exists and `~/.job-quest/` does not, seed `~/.job-quest/` from the legacy install.
4. If both paths exist, prefer `~/.job-quest/` as canonical when reconciliation succeeds; otherwise keep the last-known-good root active for this run and treat `~/.claude/job-quest` as legacy state to reconcile or retire using the conflict rules below.
5. Always write a valid runtime descriptor for the current run. When migration is deferred, write `migrationState=deferred`, keep `productHomeDir` pointed at the last-known-good root, and set `pendingCanonicalHomeDir=~/.job-quest` so consumers can continue safely while surfacing the migration warning.
6. Set `detectedRuntime` from the invoking CLI and initialize `activeRuntime` to the same value on first bootstrap only after the selected runtime passes validation for background and interactive consumers.
7. Preserve runtime-native registration artifacts for Claude users while adding Codex registration support later in the install surface phase.

Migration scope during bootstrap:

- Product app files move under `~/.job-quest/app/`.
- Mutable user data moves or is adopted under `~/.job-quest/data/`.
- Shared helper entrypoints live under `~/.job-quest/bin/`.
- Static prompt/reference files live under `~/.job-quest/references/`.

Legacy-to-canonical mapping rules:

- `~/.claude/job-quest/profile.json` -> `~/.job-quest/data/profile.json`
- `~/.claude/job-quest/role-actions.json` -> `~/.job-quest/data/role-actions.json`
- `~/.claude/job-quest/{intel,quizzes,tasks,problems,behavioral,conversations,sd-conversations,resume-files,logs}/` -> `~/.job-quest/data/...`
- `~/.claude/job-quest/skill/bin/*` -> regenerated into `~/.job-quest/bin/` from the installed product, not copied into `data/`
- Repo checkout files, dashboard source, and static references under the legacy root -> regenerated into `app/` or `references/`, not merged into `data/`

Conflict resolution rules when both roots exist:

1. Compare each writable file under the legacy and canonical data trees by relative path and hash before mutating either root.
2. If only one copy exists, adopt that copy into `~/.job-quest/data/`.
3. If both copies exist and hashes match, keep the canonical copy and mark the legacy copy as redundant.
4. If both copies exist and differ, block migration for that run, emit a conflict report, and keep startup bound to the last-known-good root until the user or a later phase resolves the conflict.
5. In that deferred state, `runtime.json` must still be written with `migrationState=deferred`, the last-known-good `productHomeDir`, and `pendingCanonicalHomeDir=~/.job-quest` so schedulers, helpers, and the server have one persisted source of truth.
6. Treat `runtime.json`, schedule metadata, and registration artifacts as regenerated outputs, not merge inputs; they are rewritten from the validated shared-home contract after data reconciliation succeeds.

## Automatic Runtime Switch

Runtime switching is invocation-driven and persisted automatically.

Rules:

1. Every supported runtime invocation records `detectedRuntime`.
2. If the invoking runtime differs from `activeRuntime`, Job Quest records the new `detectedRuntime` immediately but keeps the existing `activeRuntime` until the candidate runtime passes readiness checks.
3. Readiness checks must verify the runtime command from the non-interactive environment used by scheduled jobs and helper wrappers, plus the runtime-native registration artifact that points at `~/.job-quest/`.
4. Only after those checks pass does Job Quest update `activeRuntime` and refresh the resolved runtime-specific fields in `runtime.json`, including registration root, registration directory, command, command args, display name, and entry mode.
5. If readiness checks fail, Job Quest keeps the current `activeRuntime`, records the failure for diagnostics, and surfaces a recoverable warning instead of flipping scheduled or server-triggered flows to a broken runtime.
6. The user must not need to reinstall to switch runtimes; invoking Job Quest from the other supported runtime is enough to persist the new default without reinstall once readiness checks pass.

Example sequence:

- A user installs Job Quest through Claude first. Bootstrap sets `activeRuntime=claude`.
- The same user later invokes Job Quest from Codex against the existing shared home.
- Job Quest records `detectedRuntime=codex`, validates Codex readiness for the shared-home runner, then updates `activeRuntime=codex` and persists the Codex command and registration metadata.
- The shared `~/.job-quest/data/` footprint remains unchanged.

## Scheduler and Helper Script Impact

The scheduler and helper scripts must follow the shared home and active runtime after migration.

- Schedule installation must resolve the runner from `~/.job-quest/bin/`, not `~/.claude/job-quest/bin/`.
- The scheduler label `com.sidequest.job-quest.daily-intel` may remain stable to avoid breaking existing cleanup and status checks, but its program arguments must point at the shared-home runner.
- Daily intel generation must read profile, references, output files, and logs from `~/.job-quest/data/` and `~/.job-quest/references/`.
- Helper scripts triggered from the dashboard server must resolve the runtime command from `config/runtime.json` so the active runtime and scheduler agree.
- Lifecycle scripts must understand both the legacy Claude root and the new shared home so reinstall and uninstall do not strand runtime-specific artifacts or shared user data.

## Phase Handoff

This migration strategy constrains later implementation work:

- Phase 2 must implement the shared-home bootstrap, legacy import path, and runtime-native registration placement for Claude and Codex.
- Phase 3 must route helper execution and scheduled intel through the persisted `activeRuntime` contract instead of direct Claude detection.
- Phase 4 must update the dashboard server and surfaced commands so they no longer expose legacy `~/.claude/job-quest` assumptions.
- Phase 5 must document the migration path clearly for existing Claude users and new Codex users.
