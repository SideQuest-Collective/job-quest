# Phase 3: Runtime-Aware AI Execution - Context

**Gathered:** 2026-04-22
**Status:** Complete

<domain>
## Phase Boundary

Unify runtime command resolution so scheduled intel, plan generation, code review, and editing flows all route through the same active-runtime descriptor.

</domain>

<decisions>
## Implementation Decisions

- Add one shared runtime module in `lib/runtime.js`.
- Add shell helpers in `lib/runtime-shell.sh`.
- Make dashboard wrappers delegate to the skill/bin scripts instead of keeping separate Claude-only copies.

</decisions>
