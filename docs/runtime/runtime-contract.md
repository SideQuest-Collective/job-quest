# Runtime Config Contract

This contract turns the findings in [runtime-coupling-audit.md](./runtime-coupling-audit.md) into one implementation target for installers, helper scripts, the scheduler, the server, and future UI wording. The goal is to replace Claude-only literals such as `~/.claude/job-quest`, `~/.claude/skills/job-quest`, direct `claude` lookups, and duplicated wrapper-specific path logic with a single shared runtime descriptor.

## Goals

- Preserve one Job Quest installation and one shared local data footprint for both supported runtimes.
- Keep runtime-native registration artifacts in runtime-native locations instead of forcing Claude and Codex into the same registration root.
- Give every later phase one exact config shape for path resolution, command invocation, and runtime switching.
- Preserve existing Claude users by treating the legacy Claude-root install as migration input rather than an unsupported state.

## Shared Product Home Layout

The canonical Job Quest product home is `~/.job-quest/`.

Required layout:

- `~/.job-quest/app/`
  Product source checkout and runtime-owned application files used to launch the dashboard and shared helpers.
- `~/.job-quest/data/`
  Mutable user data and generated artifacts, including intel, quizzes, tasks, problems, profile state, logs, and other local JSON files.
- `~/.job-quest/bin/`
  Runtime-neutral launcher and helper entrypoints copied or linked from the installed product.
- `~/.job-quest/references/`
  Shared static prompt/reference files used by scheduled jobs and runtime helpers.
- `~/.job-quest/config/runtime.json`
  Persisted runtime descriptor for install/bootstrap/runtime-switch behavior.

Directory ownership rules:

- `app/` may be replaced during reinstall or upgrade.
- `data/` is the long-lived source of truth and must survive runtime changes.
- `bin/` contains wrappers that resolve the active runtime through `config/runtime.json`; they must not hard-code Claude-only or Codex-only paths.
- `references/` is shared content copied from the product install and may be refreshed on reinstall.
- `config/runtime.json` is the only persisted source of truth for runtime selection and resolved installation paths.

## Runtime Descriptor

`~/.job-quest/config/runtime.json` must expose these exact keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | string | Contract version for the runtime descriptor shape. |
| `migrationState` | string | Bootstrap/migration status for the descriptor. Allowed values: `ready`, `deferred`. |
| `activeRuntime` | string | Persisted default runtime Job Quest should use now. Allowed values: `claude`, `codex`. |
| `detectedRuntime` | string | Runtime inferred from the current invoking CLI or registration surface during the current bootstrap or invocation. Allowed values: `claude`, `codex`. |
| `productHomeDir` | string | Effective product home for the current run. Must resolve to `~/.job-quest` when `migrationState=ready`; may temporarily point at the last-known-good root when `migrationState=deferred`. |
| `pendingCanonicalHomeDir` | string | Intended canonical shared home when migration is deferred. Required when `migrationState` is `deferred`. |
| `appDir` | string | Resolved path to the installed product app subtree under `productHomeDir`. |
| `dataDir` | string | Resolved path to mutable user data under `productHomeDir`. |
| `binDir` | string | Resolved path to runtime-neutral helper binaries under `productHomeDir`. |
| `referencesDir` | string | Resolved path to shared static references under `productHomeDir`. |
| `runtimeRegistrationRoot` | string | Runtime-native directory where the active runtime expects Job Quest registration artifacts to live. |
| `runtimeSkillDir` | string | Runtime-native Job Quest registration directory inside `runtimeRegistrationRoot`. |
| `runtimeRegistrationFile` | string | Runtime-native file the installer writes inside `runtimeSkillDir` for the active runtime, such as `SKILL.md`. |
| `runtimeCommand` | string | Executable currently validated for the active runtime CLI. |
| `runtimeCommandArgs` | string[] | Stable argument prefix for the validated runtime command currently in use before Job Quest appends prompt/input-specific arguments. |
| `runtimeDisplayName` | string | User-facing runtime name for logs, API responses, and docs generated from config. |
| `runtimeEntryMode` | string | Registration style the runtime expects. Allowed values: `skill`, `instruction`. |
| `runtimeSwitchPolicy` | string | Persisted policy controlling whether later invocation from another supported runtime updates `activeRuntime`. Required value for this milestone: `persist-on-invoke`. |
| `supportedRuntimes` | object | Catalog of supported runtime descriptors keyed by runtime id so installers and wrappers can derive resolved active-runtime fields without inventing ad hoc tables. |

Normalization rules:

- `schemaVersion` is required even when the file is first bootstrapped.
- `migrationState=ready` means the descriptor points at the canonical shared home. `migrationState=deferred` means the descriptor points at the last-known-good root for this run while migration is postponed.
- When `migrationState=deferred`, `productHomeDir` may temporarily point at the last-known-good runtime root and `pendingCanonicalHomeDir` must point at `~/.job-quest`.
- `activeRuntime` and `detectedRuntime` must use the same enum values.
- `productHomeDir`, `appDir`, `dataDir`, `binDir`, `referencesDir`, `runtimeRegistrationRoot`, and `runtimeSkillDir` are stored as user-home-relative strings in config examples and may be expanded to absolute paths at runtime.
- `runtimeRegistrationFile` names the concrete runtime-native artifact inside `runtimeSkillDir`; later install phases must not guess this from runtime id alone.
- `runtimeCommand` is the executable only; `runtimeCommandArgs` carries any fixed flags or subcommands.
- `runtimeDisplayName` must be suitable for direct display without further mapping.
- `supportedRuntimes` is required for supported runtime metadata. Each runtime entry must expose `displayName`, `registrationRoot`, `skillDir`, `registrationFile`, `command`, `commandArgs`, `commandCandidates`, and `entryMode`.
- Within `supportedRuntimes`, `command` and `commandArgs` represent the default preferred command for that runtime, while `commandCandidates` captures the full ordered fallback chain.
- The resolved active-runtime fields (`runtimeRegistrationRoot`, `runtimeSkillDir`, `runtimeRegistrationFile`, `runtimeDisplayName`, and `runtimeEntryMode`) must always match the currently selected entry in `supportedRuntimes`.
- `commandCandidates` is an ordered list of allowed runtime command probes. The resolved top-level `runtimeCommand` and `runtimeCommandArgs` must match the validated candidate currently in use.

## Path Resolution Rules

1. Resolve `productHomeDir` first. The canonical target is `~/.job-quest`, except when `migrationState=deferred` and the descriptor explicitly points at a documented last-known-good root for continuity.
2. Derive `appDir`, `dataDir`, `binDir`, and `referencesDir` from `productHomeDir`; consumers must not recompute alternate roots.
3. `runtimeRegistrationRoot` and `runtimeSkillDir` are runtime-specific and may point outside `productHomeDir`.
4. Runtime-specific registration files live under `runtimeSkillDir`, and the concrete file name is `runtimeRegistrationFile`; they must point back to the shared `productHomeDir` layout.
5. Scheduled jobs, the dashboard server, uninstall/reinstall flows, and helper scripts must read writable state from `dataDir`, not from `appDir`.
6. If a legacy Claude install exists at `~/.claude/job-quest`, that path is migration input only. It is not the canonical resolved `productHomeDir` once migration has completed.
7. If a consumer cannot resolve `config/runtime.json`, it may perform bootstrap discovery, but it must write the resolved descriptor back to `config/runtime.json` before continuing normal operation.
8. Consumers must honor `migrationState=deferred` by using the descriptor's last-known-good resolved paths for the current run while surfacing the deferred migration warning.

## Command Resolution Rules

1. Runtime-backed helpers must read `runtimeCommand`, `runtimeCommandArgs`, and the selected runtime's `commandCandidates` from the runtime descriptor instead of probing `claude` or `codex` independently in each script.
2. `runtimeCommand` plus `runtimeCommandArgs` defines the validated command prefix currently in use for AI-backed execution, including scheduled intel and server-triggered helper flows.
3. Scripts may append task-specific flags after `runtimeCommandArgs`, but they must not overwrite the configured command prefix.
4. User-facing recovery messages must use `runtimeDisplayName` and `runtimeEntryMode` instead of hard-coded "Claude" or "Claude Code" text.
5. Consumers that need runtime-native registration paths must read `runtimeRegistrationRoot`, `runtimeSkillDir`, and `runtimeRegistrationFile` from the descriptor rather than deriving them from `activeRuntime` inline.
6. The shared runtime contract is CLI-only for this milestone. No consumer should infer direct API credentials or provider-specific HTTP flows from this config.
7. Runtime validation may probe `commandCandidates` in order, but once one candidate succeeds, the winning choice must be persisted back into the resolved top-level `runtimeCommand` and `runtimeCommandArgs` without mutating the catalog's default `command` and `commandArgs`.

## Runtime Switch Semantics

Bootstrap and later invocations follow one persisted default:

1. On first bootstrap, Job Quest detects the invoking runtime and sets both `detectedRuntime` and `activeRuntime` to that runtime.
2. The initial runtime descriptor always points product paths at `~/.job-quest/...` even if bootstrap is running from a legacy Claude install.
3. On later invocation, Job Quest records the current invoking runtime as `detectedRuntime`.
4. If `detectedRuntime` differs from `activeRuntime` and `runtimeSwitchPolicy` is `persist-on-invoke`, Job Quest must first validate the candidate runtime in the same non-interactive environments used by scheduled jobs, helper wrappers, and server-triggered flows.
5. Validation must confirm the candidate runtime command resolves, the runtime-native registration artifact exists, and the shared-home runner can execute without changing the shared data layout.
6. Only after those checks pass may Job Quest update `activeRuntime`, `runtimeRegistrationRoot`, `runtimeSkillDir`, `runtimeRegistrationFile`, `runtimeCommand`, `runtimeCommandArgs`, `runtimeDisplayName`, and `runtimeEntryMode` to the newly invoking runtime.
7. If validation fails, Job Quest persists `detectedRuntime` for diagnostics but keeps the previous `activeRuntime` as the default and surfaces a recoverable warning instead of breaking background flows.
8. Runtime switching must not require reinstall as long as the shared product home and required registration artifact for the invoking runtime are present.
9. Runtime switching must not create a second product home or split user data across runtimes.

## Consumer Responsibilities

- Installers own creating `~/.job-quest/`, populating the required subdirectories, and writing the initial runtime descriptor.
- Installers also own seeding and maintaining the `supportedRuntimes` catalog so later phases do not hard-code runtime metadata in multiple places.
- Registration flows own placing runtime-native artifacts under `runtimeSkillDir` while keeping them pointed at the shared home.
- Helper scripts and scheduled jobs own reading the descriptor before resolving paths or runtime commands.
- The server and UI-owning phases must stop surfacing raw Claude-only literals and instead render runtime-specific names and command hints from the descriptor.
- Uninstall and reinstall flows must treat `dataDir` as shared user state and avoid deleting it unless the user explicitly chooses full removal.
- Migration logic must preserve existing Claude behavior while moving canonical ownership to the shared contract described here.
