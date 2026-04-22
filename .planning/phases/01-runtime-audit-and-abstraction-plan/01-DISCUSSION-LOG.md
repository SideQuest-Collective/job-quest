# Phase 1: Runtime Audit and Abstraction Plan - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** 01-Runtime Audit and Abstraction Plan
**Areas discussed:** Install root and data layout, Runtime command contract, User-facing command and naming strategy, Migration and backward-compatibility strictness

---

## Install root and data layout

| Option | Description | Selected |
|--------|-------------|----------|
| Neutral shared home | Runtime-agnostic Job Quest root with runtime-specific registration kept separately | ✓ |
| Shared data, runtime-specific install roots | Separate runtime installs pointed at one shared data directory | |
| Keep Claude root canonical | Continue treating `~/.claude/job-quest` as the canonical install | |
| You decide | Leave this decision to the agent | |

**User's choice:** Neutral shared home  
**Notes:** User wants later phases to move away from Claude as the canonical product home.

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, separate them | Split app/runtime assets from mutable user data inside the neutral Job Quest root | ✓ |
| No, keep one unified Job Quest root | Keep code, scripts, and user data together | |
| You decide | Leave this decision to the agent | |

**User's choice:** Yes, separate them  
**Notes:** This makes reinstall/update behavior safer and clearer.

---

## Runtime command contract

| Option | Description | Selected |
|--------|-------------|----------|
| One shared runtime wrapper | A single Job Quest wrapper chooses the runtime for all AI-backed actions | ✓ |
| Separate Claude and Codex paths | Each feature chooses between distinct runtime-specific integrations | |
| Wrapper now, but only for Claude + Codex | A shared adapter exists but is intentionally limited to these two runtimes | |
| You decide | Leave this decision to the agent | |

**User's choice:** One shared runtime wrapper  
**Notes:** User explicitly added that both Claude and Codex must be used through their CLIs, not through provider APIs.

| Option | Description | Selected |
|--------|-------------|----------|
| Install-time default, changeable later | Store an active runtime in config and allow later switching | ✓ |
| Install-time fixed | Runtime stays fixed unless reinstalled or edited manually | |
| Per-command override | Each command can independently choose a runtime | |
| You decide | Leave this decision to the agent | |

**User's choice:** Install-time default, changeable later  
**Notes:** This keeps the experience coherent while still permitting runtime changes.

---

## User-facing command and naming strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Runtime-native entrypoints, product-neutral language elsewhere | Use native runtime entrypoints but keep surrounding product language centered on Job Quest | ✓ |
| Fully runtime-native everywhere | Adapt docs, prompts, and UI deeply to each runtime | |
| Keep Claude naming as the baseline and add Codex notes | Preserve Claude-first wording and annotate Codex support | |
| You decide | Leave this decision to the agent | |

**User's choice:** Runtime-native entrypoints, product-neutral language elsewhere  
**Notes:** User wants the product identity to remain “Job Quest,” not “the Claude version” or “the Codex version.”

| Option | Description | Selected |
|--------|-------------|----------|
| Accept runtime-specific entrypoints | Each runtime can use its natural invocation mechanism as long as Job Quest behavior converges | ✓ |
| Force one identical product command everywhere | Try to make the top-level command name identical across runtimes | |
| You decide | Leave this decision to the agent | |

**User's choice:** Accept runtime-specific entrypoints  
**Notes:** User prefers aligning with runtime conventions over enforcing identical command names.

---

## Migration and backward-compatibility strictness

| Option | Description | Selected |
|--------|-------------|----------|
| No breakage for existing Claude users | Introduce the new architecture without disrupting current Claude installs | ✓ |
| Allow an explicit one-time migration | Move users only through a deliberate migration flow | |
| Clean break is acceptable | Prioritize architecture even if existing installs require manual recovery | |
| You decide | Leave this decision to the agent | |

**User's choice:** No breakage for existing Claude users  
**Notes:** Backward compatibility is a hard constraint.

| Option | Description | Selected |
|--------|-------------|----------|
| Leave it in place unless user opts in | Existing installs stay where they are until a user requests migration | |
| Auto-migrate when safe | Migrate existing installs in the background when possible | |
| Alternative clarified by user | Shared install; runtime inferred from active CLI and switched automatically when invoked from the other runtime | ✓ |

**User's choice:** Shared install with automatic runtime switching based on active CLI  
**Notes:** User clarified a more specific rule than the offered options: bootstrap knows the starting runtime from the current CLI, later invocations from the other supported CLI should detect the existing initialization, switch the active runtime config automatically, and let the web app continue working without reinstall. The switch should persist as the new default.

## the agent's Discretion

- Exact neutral home path naming
- Exact config schema for persisted runtime selection
- Exact runtime-detection implementation details

## Deferred Ideas

None.
