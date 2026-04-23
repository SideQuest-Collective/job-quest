# Requirements: Job Quest

**Defined:** 2026-04-21
**Core Value:** A job seeker can install Job Quest once and use the same core workflow from their chosen agent runtime without losing the local dashboard and automation that make the product useful.

## v1 Requirements

### Compatibility

- [ ] **COMP-01**: User can install and run Job Quest from Claude without regression from the current supported flow
- [ ] **COMP-02**: User can install and run Job Quest from Codex with an equivalent top-level entrypoint and runtime guidance
- [ ] **COMP-03**: User-facing commands, prompts, and docs reference the active runtime rather than assuming Claude-only naming

### Installation

- [ ] **INST-01**: Install scripts place runtime-specific skill files in the correct location for Claude and Codex
- [ ] **INST-02**: Install scripts create or reuse a local data directory layout that works the same across supported runtimes
- [ ] **INST-03**: Uninstall and reinstall flows remove or preserve the correct runtime-specific assets without deleting shared user data unexpectedly

### Runtime Integration

- [ ] **RT-01**: AI helper scripts can invoke Claude CLI or the Codex equivalent through a shared runtime-aware wrapper
- [ ] **RT-02**: Scheduled intel generation runs through the selected runtime and produces the same JSON outputs the dashboard expects
- [x] **RT-03**: Runtime-specific configuration is centralized so new scripts do not duplicate path and command detection logic

### Product Continuity

- [ ] **PROD-01**: The dashboard continues to read and write the existing JSON data model after compatibility changes
- [ ] **PROD-02**: Existing interview-plan, code-review, and evaluation flows fail clearly when a required runtime CLI is unavailable

### Verification and Docs

- [ ] **VER-01**: README and onboarding docs explain Claude and Codex installation and day-one usage paths clearly
- [ ] **VER-02**: The repo includes a validation path proving install, skill registration, dashboard startup, and AI helper execution for each supported runtime

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
| COMP-01 | Phase 4 | Pending |
| COMP-02 | Phase 2 | Pending |
| COMP-03 | Phase 3 | Pending |
| INST-01 | Phase 2 | Pending |
| INST-02 | Phase 2 | Pending |
| INST-03 | Phase 2 | Pending |
| RT-01 | Phase 3 | Pending |
| RT-02 | Phase 3 | Pending |
| RT-03 | Phase 1 | Complete |
| PROD-01 | Phase 4 | Pending |
| PROD-02 | Phase 4 | Pending |
| VER-01 | Phase 5 | Pending |
| VER-02 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-04-21*
*Last updated: 2026-04-21 after initialization*
