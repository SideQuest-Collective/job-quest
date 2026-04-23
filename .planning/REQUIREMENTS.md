# Requirements: Job Quest

**Defined:** 2026-04-21
**Core Value:** A job seeker can install Job Quest once and use the same core workflow from their chosen agent runtime without losing the local dashboard and automation that make the product useful.

## v1 Requirements

### Compatibility

- [x] **COMP-01**: User can install and run Job Quest from Claude without regression from the current supported flow
- [x] **COMP-02**: User can install and run Job Quest from Codex with an equivalent top-level entrypoint and runtime guidance
- [x] **COMP-03**: User-facing commands, prompts, and docs reference the active runtime rather than assuming Claude-only naming

### Installation

- [x] **INST-01**: Install scripts place runtime-specific skill files in the correct location for Claude and Codex
- [x] **INST-02**: Install scripts create or reuse a local data directory layout that works the same across supported runtimes
- [x] **INST-03**: Uninstall and reinstall flows remove or preserve the correct runtime-specific assets without deleting shared user data unexpectedly

### Runtime Integration

- [x] **RT-01**: AI helper scripts can invoke Claude CLI or the Codex equivalent through a shared runtime-aware wrapper
- [x] **RT-02**: Scheduled intel generation runs through the selected runtime and produces the same JSON outputs the dashboard expects
- [x] **RT-03**: Runtime-specific configuration is centralized so new scripts do not duplicate path and command detection logic

### Product Continuity

- [x] **PROD-01**: The dashboard continues to read and write the existing JSON data model after compatibility changes
- [x] **PROD-02**: Existing interview-plan, code-review, and evaluation flows fail clearly when a required runtime CLI is unavailable

### Verification and Docs

- [x] **VER-01**: README and onboarding docs explain Claude and Codex installation and day-one usage paths clearly
- [x] **VER-02**: The repo includes a validation path proving install, skill registration, dashboard startup, and AI helper execution for each supported runtime

## v2 Requirements

### Runtime Expansion

- **RTE-01**: Support additional runtimes beyond Claude and Codex through the same abstraction layer
- **RTE-02**: Migrate from CLI-specific integration to provider-agnostic API adapters where that improves reliability

### User Experience

- **UX-01**: Offer seamless migration tooling between an existing Claude install and a new Codex install
- **UX-02**: Add richer runtime health diagnostics inside the dashboard

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full dashboard redesign | Not required to make the product runtime-compatible |
| New job-search modules unrelated to compatibility | Would dilute the current milestone |
| Universal support for every agent IDE/CLI | This milestone is intentionally limited to Claude and Codex |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| COMP-01 | Phase 4 | Complete |
| COMP-02 | Phase 2 | Complete |
| COMP-03 | Phases 3, 4, 5 | Complete |
| INST-01 | Phase 2 | Complete |
| INST-02 | Phase 2 | Complete |
| INST-03 | Phase 2 | Complete |
| RT-01 | Phase 3 | Complete |
| RT-02 | Phase 3 | Complete |
| RT-03 | Phase 1 | Complete |
| PROD-01 | Phase 4 | Complete |
| PROD-02 | Phase 4 | Complete |
| VER-01 | Phase 5 | Complete |
| VER-02 | Phase 5 | Complete |

**Coverage:**
- v1 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-04-21*
*Last updated: 2026-04-22 after Phase 5 completion*
