# Phase 1: Runtime Audit and Abstraction Plan - Research

**Researched:** 2026-04-22
**Domain:** Brownfield runtime abstraction for a local CLI-integrated product
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Job Quest should move toward a neutral, runtime-agnostic product home rather than keeping `~/.claude/job-quest` as the canonical install root.
- **D-02:** Runtime-specific registration artifacts should live in the appropriate Claude or Codex directories, but the core Job Quest install and state should be shared.
- **D-03:** Inside the neutral Job Quest home, app/runtime assets and mutable user data must be split into separate subtrees.
- **D-04:** All AI-backed behavior should go through one shared Job Quest runtime wrapper rather than separate per-feature Claude/Codex paths.
- **D-05:** The shared runtime wrapper must use local CLIs for both Claude and Codex; direct API integration is out of scope for this contract.
- **D-06:** Runtime selection should be stored as a default in config and be changeable later rather than fixed forever or overridden per command.
- **D-07:** Job Quest should use runtime-native entrypoints, while keeping the rest of the product language as neutral as possible.
- **D-08:** The product does not need one identical top-level command everywhere; it should accept runtime-specific entrypoints as long as they converge on the same Job Quest behavior.
- **D-09:** Existing Claude users must not experience breakage as Codex support is introduced.
- **D-10:** Bootstrap should infer the initial runtime from the CLI the user is currently using.
- **D-11:** Job Quest should maintain one shared installation and one shared state footprint, not separate Claude and Codex installs.
- **D-12:** If a user later invokes Job Quest from the other supported runtime, the system should detect the existing initialization and automatically switch the active runtime config to the current CLI.
- **D-13:** That runtime switch should persist as the new default until changed again.

### the agent's Discretion
- Exact neutral home path naming and directory labels under the shared Job Quest root
- Exact config file shape and persistence mechanism for the active runtime selection
- Exact detection mechanism used to infer the invoking CLI at bootstrap and at later runtime switches

### Deferred Ideas (OUT OF SCOPE)
- None
</user_constraints>

<architectural_responsibility_map>
## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Neutral install root and shared data layout | Installer/runtime packaging | Filesystem persistence | `install.sh`, uninstall/reinstall, and launch scripts currently define both code and data roots. |
| Runtime selection and command resolution | Runtime wrapper/config layer | Installer/runtime packaging | The current repo duplicates CLI detection across shell adapters and needs one shared contract. |
| Runtime-specific registration artifacts | Installer/runtime packaging | Skill/instruction surface | Claude and Codex need different registration targets while sharing the same product home. |
| Scheduler wiring and helper execution | Shell/runtime wrapper | Web server/application | Scheduled jobs and API-triggered helpers both depend on the active runtime and on stable local paths. |
| Runtime-aware UI and failure messaging | Web server/application | Frontend presentation | The API and the dashboard currently surface Claude-only names and path hints directly to the user. |
</architectural_responsibility_map>

<research_summary>
## Summary

Phase 1 should not jump straight into code changes. The highest-value output is a precise compatibility map plus a contract that later phases can implement without re-auditing the repository. The current codebase spreads Claude-only assumptions across install, scheduling, helper execution, server routes, skill packaging, and frontend copy. That makes partial abstraction risky unless the audit is explicit and source-linked.

The standard approach for this kind of brownfield runtime split is: inventory all runtime-coupled surfaces first, define one runtime descriptor that every layer can consume, and specify migration rules before changing install behavior. In this repo that means keeping the filesystem as the system of record, defining a neutral product home with separate app/data subtrees, and centralizing runtime command/path resolution instead of patching each script independently.

**Primary recommendation:** Use Phase 1 to produce four source-of-truth artifacts: a runtime coupling audit, a runtime contract, a config example, and a migration/switching spec. Those artifacts should be concrete enough that Phase 2 and Phase 3 can execute without rediscovering assumptions.
</research_summary>

<standard_stack>
## Standard Stack

### Core
| Library / Tool | Version | Purpose | Why Standard |
|----------------|---------|---------|--------------|
| Node.js + shell scripts | Existing repo stack | Install/bootstrap, helper execution, server launch | The product already runs locally through Bash and Node; no new platform is needed for the contract phase. |
| JSON config document | Existing repo pattern | Persist active runtime and resolved path metadata | The repo already stores local state as JSON and pretty-prints it consistently. |
| Markdown specs under source control | Existing repo pattern | Audit and contract source-of-truth artifacts | The codebase already uses Markdown for planning, architecture notes, and operator guidance. |

### Supporting
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `rg` / source-linked evidence tables | Coverage verification | Use for proving the audit captured every Claude-specific surface. |
| Existing shell wrapper patterns | Runtime adapter design input | Use to normalize duplicated Claude CLI discovery into one contract. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Phase-1 spec artifacts | Immediate code refactor | Faster short-term edits, but higher regression risk because the repo has no tests and many duplicated runtime seams. |
| Shared product home + shared config | Separate per-runtime installs | Simpler runtime isolation, but violates the user's shared-state constraint and complicates migration. |

**Installation:** No new dependencies should be introduced in this phase. The existing Node/Bash stack is sufficient.
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### System Architecture Diagram

```text
User invokes Claude or Codex
  -> runtime-specific registration surface resolves Job Quest entrypoint
  -> Job Quest bootstrap reads shared runtime config
  -> shared runtime config resolves:
     - product home
     - app subtree
     - data subtree
     - runtime registration targets
     - runtime CLI command + args
  -> installer / skill scripts / server helpers consume the same resolved values
  -> dashboard + scheduler continue reading/writing the same local JSON data
```

### Recommended Project Structure

```text
docs/
  runtime/
    runtime-coupling-audit.md
    runtime-contract.md
    runtime-config-example.json
    runtime-migration.md
```

### Pattern 1: Evidence-first brownfield audit
**What:** Capture each runtime-specific seam with exact file paths, exact literals, current behavior, and downstream impact.
**When to use:** Before changing install roots, CLI wrappers, or user-facing runtime wording.
**Example:** Group findings by installer, registration, scheduler, helper wrappers, server, frontend, and docs so later plans can claim complete coverage.

### Pattern 2: Single runtime descriptor
**What:** One shared configuration model holds the active runtime, product home, resolved paths, runtime registration targets, and CLI command metadata.
**When to use:** Any feature needs to know "where is Job Quest installed?" or "which CLI do I run?".
**Example:** `activeRuntime`, `productHomeDir`, `dataDir`, `runtimeRegistrationRoot`, `runtimeCommand`, and `runtimeSwitchPolicy` should all come from one config source instead of being recomputed in each shell script.

### Pattern 3: Shared product home with runtime-specific registration edges
**What:** Keep one neutral Job Quest home and one shared data footprint, while letting Claude and Codex store their skill/instruction artifacts in runtime-native locations.
**When to use:** Supporting multiple local runtimes without duplicating user state.
**Example:** Product files can live under `~/.job-quest/`, while runtime registration stays under `~/.claude/...` or `~/.codex/...`.

### Anti-Patterns to Avoid
- **Per-script runtime detection:** Repeating `command -v claude` / `command -v npx` logic in multiple scripts guarantees drift.
- **Mixed code and data roots:** Updating or deleting the install tree becomes destructive when logs, JSON state, repo files, and scripts share one directory.
- **Contract without migration rules:** A neutral path alone is not enough; existing Claude installs need explicit legacy handling and runtime-switch persistence.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Runtime path discovery | Ad hoc `HOME/.claude/...` strings in every script | One documented runtime descriptor | Path drift is already one of the repo's main risks. |
| Runtime CLI invocation | Separate feature-specific Claude/Codex wrappers | One shared command-resolution contract | Duplication across `skill/bin` and `app/scripts` is already causing maintenance risk. |
| Migration behavior | Implicit "the installer will figure it out" logic | Explicit migration doc + config example | Shared data and no-breakage constraints need deterministic behavior. |

**Key insight:** The repo does not need a new framework to support two runtimes; it needs one source of truth that all existing layers can consume.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Defining a neutral home without defining ownership
**What goes wrong:** The project moves files out of `~/.claude/job-quest`, but installer, scheduler, and helper scripts each interpret the new layout differently.
**Why it happens:** The contract names a new path but does not specify app/data/bin/references subtrees or which layer owns each path.
**How to avoid:** Define the full directory model and the contract keys that resolve every runtime-sensitive path.
**Warning signs:** Follow-on plans still mention raw `~/.claude/job-quest` or invent new path variables ad hoc.

### Pitfall 2: Treating runtime registration as the same problem as product storage
**What goes wrong:** Claude/Codex artifact placement becomes tangled with shared app/data storage, causing either duplicated installs or broken registration.
**Why it happens:** Registration surfaces and product home are separate concerns, but the current repo conflates them.
**How to avoid:** Keep runtime registration roots in dedicated contract fields and document that only the registration edge is runtime-specific.
**Warning signs:** The contract proposes separate product homes per runtime or leaves registration targets implicit.

### Pitfall 3: Designing runtime switching without persistence rules
**What goes wrong:** Codex can invoke Job Quest once, but scheduled jobs, server wrappers, or later invocations still use stale Claude defaults.
**Why it happens:** The switch semantics stop at CLI detection and do not define how config updates persist.
**How to avoid:** Specify bootstrap detection, later runtime detection, persisted default updates, and how the dashboard reads the active runtime.
**Warning signs:** The contract says "detect runtime dynamically" but never states when the config is rewritten.
</common_pitfalls>

## Validation Architecture

This phase is documentation-heavy, so validation should be artifact-based instead of test-framework-based.

- Audit validation: prove `docs/runtime/runtime-coupling-audit.md` names every currently known runtime-coupled file and the exact literals that couple them to Claude.
- Contract validation: prove `docs/runtime/runtime-contract.md` contains the agreed config keys, the neutral home layout, CLI resolution rules, and runtime-switch semantics.
- Config validation: prove `docs/runtime/runtime-config-example.json` contains the keys later phases must read and write.
- Migration validation: prove `docs/runtime/runtime-migration.md` explains legacy `~/.claude/job-quest` handling, no-breakage requirements, and automatic runtime switching.

Recommended execution-time verification is simple and fast:
- `rg` for required headings and required keys in the docs/config example
- `rg` for exact audited files and literals in the audit doc
- No new test framework in Phase 1; keep verification under 10 seconds

If Phase 2 or Phase 3 cannot point back to these artifacts, Phase 1 was not specific enough.

<open_questions>
## Open Questions

1. **Should the neutral product home be `~/.job-quest/` or another name?**
   - What we know: It must be runtime-agnostic, shared across Claude and Codex, and distinct from runtime registration roots.
   - What's unclear: The repo does not yet have an established non-Claude install root.
   - Recommendation: Standardize on `~/.job-quest/` in the contract and let Phase 2 implement it.

2. **How much of the legacy Claude install should remain as a compatibility shim?**
   - What we know: Existing Claude users must not break, and later Codex invocation should switch the active runtime automatically.
   - What's unclear: Whether the legacy path should become a shim, a migration source only, or both.
   - Recommendation: Make the migration doc explicit about preserving compatibility while moving the canonical home to the neutral root.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `.planning/phases/01-runtime-audit-and-abstraction-plan/01-CONTEXT.md` - locked decisions and phase boundary
- `.planning/ROADMAP.md` - goal, success criteria, and plan breakdown
- `.planning/REQUIREMENTS.md` - `RT-03` scope
- `.planning/codebase/ARCHITECTURE.md` - current runtime layering and Claude coupling spread
- `.planning/codebase/STRUCTURE.md` - repo layout and duplicated wrapper surfaces
- `.planning/codebase/CONCERNS.md` - confirmed compatibility and install-root risks
- `install.sh` - canonical install/root assumptions
- `skill/SKILL.md` - runtime-facing onboarding, storage, and scheduling contract
- `skill/bin/*.sh` and `app/scripts/*.sh` - duplicated helper invocation patterns
- `app/server.js` and `app/public/index.html` - server and UI runtime assumptions

### Secondary (MEDIUM confidence)
- `README.md` - user-facing install and command expectations
- `.planning/codebase/CONVENTIONS.md` - JSON/file conventions and local shell style

### Tertiary (LOW confidence - needs validation during implementation)
- None
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: local Node/Bash product runtime abstraction
- Ecosystem: existing repo-only patterns
- Patterns: shared runtime descriptor, neutral product home, runtime registration edge separation
- Pitfalls: mixed install/data roots, duplicated wrapper logic, missing switch persistence

**Confidence breakdown:**
- Standard stack: HIGH - no new external stack is required in this phase
- Architecture: HIGH - current runtime seams are visible directly in repo files
- Pitfalls: HIGH - concerns are already confirmed in codebase audit docs
- Code examples: MEDIUM - this phase is spec-first rather than implementation-first
</metadata>
