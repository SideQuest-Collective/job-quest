# Phase 1: Runtime Audit and Abstraction Plan - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase catalogs the runtime-specific assumptions already embedded in Job Quest and defines the shared configuration contract that later phases will implement. It does not add Codex support yet; it locks the install, runtime-selection, naming, and migration decisions that planning and implementation must follow.

</domain>

<decisions>
## Implementation Decisions

### Install root and data layout
- **D-01:** Job Quest should move toward a neutral, runtime-agnostic product home rather than keeping `~/.claude/job-quest` as the canonical install root.
- **D-02:** Runtime-specific registration artifacts should live in the appropriate Claude or Codex directories, but the core Job Quest install and state should be shared.
- **D-03:** Inside the neutral Job Quest home, app/runtime assets and mutable user data must be split into separate subtrees.

### Runtime command contract
- **D-04:** All AI-backed behavior should go through one shared Job Quest runtime wrapper rather than separate per-feature Claude/Codex paths.
- **D-05:** The shared runtime wrapper must use local CLIs for both Claude and Codex; direct API integration is out of scope for this contract.
- **D-06:** Runtime selection should be stored as a default in config and be changeable later rather than fixed forever or overridden per command.

### User-facing command and naming strategy
- **D-07:** Job Quest should use runtime-native entrypoints, while keeping the rest of the product language as neutral as possible.
- **D-08:** The product does not need one identical top-level command everywhere; it should accept runtime-specific entrypoints as long as they converge on the same Job Quest behavior.

### Migration and backward-compatibility strictness
- **D-09:** Existing Claude users must not experience breakage as Codex support is introduced.
- **D-10:** Bootstrap should infer the initial runtime from the CLI the user is currently using.
- **D-11:** Job Quest should maintain one shared installation and one shared state footprint, not separate Claude and Codex installs.
- **D-12:** If a user later invokes Job Quest from the other supported runtime, the system should detect the existing initialization and automatically switch the active runtime config to the current CLI.
- **D-13:** That runtime switch should persist as the new default until changed again.

### the agent's Discretion
- Exact neutral home path naming and directory labels under the shared Job Quest root
- Exact config file shape and persistence mechanism for the active runtime selection
- Exact detection mechanism used to infer the invoking CLI at bootstrap and at later runtime switches

</decisions>

<specifics>
## Specific Ideas

- Bootstrap should determine the initial runtime from the CLI the user is currently using.
- If the user first bootstraps in Claude and later runs the skill from Codex, Job Quest should recognize the existing installation and flip the active runtime over to Codex automatically.
- The web app should follow the active runtime config and continue working after that switch without requiring reinstall.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project and phase framing
- `.planning/PROJECT.md` — project goals, constraints, and the decision to treat compatibility as a brownfield effort
- `.planning/REQUIREMENTS.md` — Phase 1 maps to `RT-03`, which requires centralized runtime-specific configuration
- `.planning/ROADMAP.md` — Phase 1 goal, success criteria, and plan breakdown
- `.planning/STATE.md` — current phase position and known concerns carried into discussion

### Codebase audit inputs
- `.planning/codebase/ARCHITECTURE.md` — current runtime layering and where Claude coupling lives
- `.planning/codebase/STRUCTURE.md` — repo layout, install/runtime boundaries, and duplicated script surfaces
- `.planning/codebase/STACK.md` — current CLI/runtime/tooling stack and local-first deployment assumptions
- `.planning/codebase/CONVENTIONS.md` — established persistence and script conventions that refactors should respect
- `.planning/codebase/INTEGRATIONS.md` — external and local CLI integrations currently relied on by the product
- `.planning/codebase/CONCERNS.md` — confirmed risks around mixed install/data roots, duplicated wrappers, and runtime coupling

### Current implementation anchors
- `install.sh` — current bootstrap flow, path assumptions, skill registration, and data seeding
- `skill/SKILL.md` — current Claude-facing runtime entrypoint and onboarding language
- `skill/bin/run-daily-intel.sh` — current scheduled runtime invocation and generated output contract
- `skill/bin/install-schedule.sh` — current runtime-facing scheduling commands and OS integration
- `skill/bin/start.sh` — current installed app launch behavior
- `app/server.js` — current server-side AI helper invocation, persistence behavior, and runtime-sensitive endpoints
- `app/public/index.html` — current UI/runtime wording and hard-coded runtime-specific instructions
- `app/scripts/generate-plan.sh` — current CLI-backed generation wrapper used by the app
- `app/scripts/code-review.sh` — current CLI-backed review wrapper used by the app
- `README.md` — current installation, runtime expectations, and user-facing command language

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `install.sh`: Existing bootstrap, dependency install, and data-seeding flow that can be refactored into a neutral install root rather than replaced.
- `skill/bin/start.sh`: Existing runtime launcher pattern that already injects `DATA_DIR` and can later be adapted to runtime-aware config.
- `skill/bin/run-daily-intel.sh`: Existing scheduled generation flow that defines the output contract for daily intel, quizzes, tasks, and problems.
- `app/scripts/generate-plan.sh` and `app/scripts/code-review.sh`: Existing wrapper shape for CLI-backed AI operations, useful as the starting point for a single shared runtime adapter.
- `app/server.js`: Existing central point where runtime-backed features are triggered and where a shared runtime execution layer will need to integrate.

### Established Patterns
- Local-first JSON persistence under a single product root is the current system of record, so runtime changes must preserve the existing data model.
- AI features are currently CLI-driven rather than API-driven, which aligns with the decision to keep both Claude and Codex integrations on local CLIs.
- The current install mixes app code and user data in one tree, which is a known anti-pattern that this phase is explicitly preparing to unwind.
- User-facing runtime hints are currently embedded in docs, shell scripts, server responses, and the monolithic frontend, so planning must treat runtime wording as a cross-cutting concern.

### Integration Points
- Bootstrap and runtime registration changes connect through `install.sh` and the runtime-specific files under `skill/`.
- Active-runtime switching will need to reach both the CLI wrapper layer and the web app config surface so that server routes and UI copy follow the same runtime.
- Later implementation phases will need to unify the duplicated wrapper logic between `skill/bin/*.sh` and `app/scripts/*.sh`.

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---
*Phase: 01-runtime-audit-and-abstraction-plan*
*Context gathered: 2026-04-22*
