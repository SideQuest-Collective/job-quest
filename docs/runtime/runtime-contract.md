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
| `activeRuntime` | string | Persisted default runtime Job Quest should use now. Allowed values: `claude`, `codex`. |
| `detectedRuntime` | string | Runtime inferred from the current invoking CLI or registration surface during the current bootstrap or invocation. Allowed values: `claude`, `codex`. |
| `productHomeDir` | string | Canonical shared product home. Must resolve to `~/.job-quest`. |
| `appDir` | string | Resolved path to the installed product app subtree under `productHomeDir`. |
| `dataDir` | string | Resolved path to mutable user data under `productHomeDir`. |
| `binDir` | string | Resolved path to runtime-neutral helper binaries under `productHomeDir`. |
| `referencesDir` | string | Resolved path to shared static references under `productHomeDir`. |
| `runtimeRegistrationRoot` | string | Runtime-native directory where the active runtime expects Job Quest registration artifacts to live. |
| `runtimeSkillDir` | string | Runtime-native Job Quest registration directory inside `runtimeRegistrationRoot`. |
| `runtimeCommand` | string | Executable used to invoke the active runtime CLI. |
| `runtimeCommandArgs` | string[] | Stable argument prefix required before Job Quest appends prompt/input-specific arguments. |
| `runtimeDisplayName` | string | User-facing runtime name for logs, API responses, and docs generated from config. |
| `runtimeEntryMode` | string | Registration style the runtime expects. Allowed values: `skill`, `instruction`. |
| `runtimeSwitchPolicy` | string | Persisted policy controlling whether later invocation from another supported runtime updates `activeRuntime`. Required value for this milestone: `persist-on-invoke`. |

Normalization rules:

- `schemaVersion` is required even when the file is first bootstrapped.
- `activeRuntime` and `detectedRuntime` must use the same enum values.
- `productHomeDir`, `appDir`, `dataDir`, `binDir`, `referencesDir`, `runtimeRegistrationRoot`, and `runtimeSkillDir` are stored as user-home-relative strings in config examples and may be expanded to absolute paths at runtime.
- `runtimeCommand` is the executable only; `runtimeCommandArgs` carries any fixed flags or subcommands.
- `runtimeDisplayName` must be suitable for direct display without further mapping.

## Path Resolution Rules

1. Resolve `productHomeDir` first. The canonical target is `~/.job-quest`.
2. Derive `appDir`, `dataDir`, `binDir`, and `referencesDir` from `productHomeDir`; consumers must not recompute alternate roots.
3. `runtimeRegistrationRoot` and `runtimeSkillDir` are runtime-specific and may point outside `productHomeDir`.
4. Runtime-specific registration files live under `runtimeSkillDir`, but they must point back to the shared `productHomeDir` layout.
5. Scheduled jobs, the dashboard server, uninstall/reinstall flows, and helper scripts must read writable state from `dataDir`, not from `appDir`.
6. If a legacy Claude install exists at `~/.claude/job-quest`, that path is migration input only. It is not the canonical resolved `productHomeDir` once migration has completed.
7. If a consumer cannot resolve `config/runtime.json`, it may perform bootstrap discovery, but it must write the resolved descriptor back to `config/runtime.json` before continuing normal operation.

## Command Resolution Rules

1. Runtime-backed helpers must read `runtimeCommand` and `runtimeCommandArgs` from the runtime descriptor instead of probing `claude` or `codex` independently in each script.
2. `runtimeCommand` plus `runtimeCommandArgs` defines the stable command prefix for AI-backed execution, including scheduled intel and server-triggered helper flows.
3. Scripts may append task-specific flags after `runtimeCommandArgs`, but they must not overwrite the configured command prefix.
4. User-facing recovery messages must use `runtimeDisplayName` and `runtimeEntryMode` instead of hard-coded "Claude" or "Claude Code" text.
5. Consumers that need runtime-native registration paths must read `runtimeRegistrationRoot` and `runtimeSkillDir` from the descriptor rather than deriving them from `activeRuntime` inline.
6. The shared runtime contract is CLI-only for this milestone. No consumer should infer direct API credentials or provider-specific HTTP flows from this config.

## Runtime Switch Semantics

Bootstrap and later invocations follow one persisted default:

1. On first bootstrap, Job Quest detects the invoking runtime and sets both `detectedRuntime` and `activeRuntime` to that runtime.
2. The initial runtime descriptor always points product paths at `~/.job-quest/...` even if bootstrap is running from a legacy Claude install.
3. On later invocation, Job Quest records the current invoking runtime as `detectedRuntime`.
4. If `detectedRuntime` differs from `activeRuntime` and `runtimeSwitchPolicy` is `persist-on-invoke`, Job Quest updates `activeRuntime`, `runtimeRegistrationRoot`, `runtimeSkillDir`, `runtimeCommand`, `runtimeCommandArgs`, `runtimeDisplayName`, and `runtimeEntryMode` to the newly invoking runtime.
5. That switch persists immediately in `config/runtime.json` and becomes the new default for scheduled jobs, helper wrappers, dashboard-triggered AI flows, and future invocations.
6. Runtime switching must not require reinstall as long as the shared product home and required registration artifact for the invoking runtime are present.
7. Runtime switching must not create a second product home or split user data across runtimes.

## Consumer Responsibilities

- Installers own creating `~/.job-quest/`, populating the required subdirectories, and writing the initial runtime descriptor.
- Registration flows own placing runtime-native artifacts under `runtimeSkillDir` while keeping them pointed at the shared home.
- Helper scripts and scheduled jobs own reading the descriptor before resolving paths or runtime commands.
- The server and UI-owning phases must stop surfacing raw Claude-only literals and instead render runtime-specific names and command hints from the descriptor.
- Uninstall and reinstall flows must treat `dataDir` as shared user state and avoid deleting it unless the user explicitly chooses full removal.
- Migration logic must preserve existing Claude behavior while moving canonical ownership to the shared contract described here.
