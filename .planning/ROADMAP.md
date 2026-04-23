# Roadmap: Job Quest

## Overview

This milestone turns Job Quest from a Claude-only local skill into a dual-runtime product that works in Claude and Codex while preserving the existing dashboard, local data model, and AI-assisted workflows. The path is to isolate runtime assumptions first, then update install and skill surfaces, then switch helper execution over to shared runtime-aware infrastructure, and finally verify the end-to-end user experience in both runtimes.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Runtime Audit and Abstraction Plan** - Identify Claude-specific coupling and define the shared runtime contract
- [x] **Phase 2: Dual-Runtime Install Surface** - Make install, uninstall, and skill registration work for Claude and Codex
- [x] **Phase 3: Runtime-Aware AI Execution** - Route helper scripts and scheduled jobs through a shared Claude/Codex execution layer
- [x] **Phase 4: Product Integration Hardening** - Preserve dashboard behavior and close runtime-specific regressions
- [x] **Phase 5: Documentation and Validation** - Publish dual-runtime guidance and prove the supported flows work

## Phase Details

### Phase 1: Runtime Audit and Abstraction Plan
**Goal**: Establish the compatibility boundary by inventorying runtime-specific assumptions and introducing a single configuration model for path and command resolution.
**Depends on**: Nothing (first phase)
**Requirements**: [RT-03]
**Success Criteria** (what must be TRUE):
  1. Runtime-specific assumptions in scripts, prompts, docs, and skill assets are cataloged
  2. A shared runtime configuration contract exists for path resolution and command invocation
  3. Follow-on phases can update runtime behavior without rediscovering where Claude-only coupling lives
**Plans**: 2 plans

Plans:
- [x] 01-01: Audit Claude-specific paths, commands, and command names across the repo
- [x] 01-02: Define the shared runtime configuration shape and migration approach

### Phase 2: Dual-Runtime Install Surface
**Goal**: Update installation, uninstall, reinstall, and skill asset placement so Claude and Codex installs land in the right locations without breaking shared data.
**Depends on**: Phase 1
**Requirements**: [COMP-02, INST-01, INST-02, INST-03]
**Success Criteria** (what must be TRUE):
  1. A Codex user can install Job Quest and get the required skill or instruction files in the correct place
  2. Claude installation behavior still works with the same local data layout expectations
  3. Uninstall and reinstall flows handle runtime-specific assets safely while preserving shared data when requested
**Plans**: 3 plans

Plans:
- [x] 02-01: Refactor install-time directory and runtime detection logic
- [x] 02-02: Add Codex-compatible skill or instruction artifact generation and registration
- [x] 02-03: Align uninstall and reinstall behavior with the new dual-runtime layout

### Phase 3: Runtime-Aware AI Execution
**Goal**: Replace direct Claude-only helper invocation with a runtime-aware execution layer used by scripts and scheduled intel generation.
**Depends on**: Phase 2
**Requirements**: [COMP-03, RT-01, RT-02]
**Success Criteria** (what must be TRUE):
  1. Helper scripts choose the active runtime command through shared logic rather than hard-coded Claude calls
  2. Scheduled intel generation can run through the selected runtime and still emit dashboard-compatible JSON
  3. User-visible command examples and prompts no longer assume Claude-only naming
**Plans**: 3 plans

Plans:
- [x] 03-01: Build the shared runtime command wrapper used by shell scripts
- [x] 03-02: Update generation, review, and scheduling scripts to use the wrapper
- [x] 03-03: Revise prompts and surfaced command text for runtime-aware behavior

### Phase 4: Product Integration Hardening
**Goal**: Verify that the dashboard-backed product behavior remains stable after the compatibility refactor and that failures are explicit and recoverable.
**Depends on**: Phase 3
**Requirements**: [COMP-01, PROD-01, PROD-02]
**Success Criteria** (what must be TRUE):
  1. Existing dashboard flows continue to read and write the expected JSON files after compatibility changes
  2. Claude users do not lose current product capabilities while Codex support is introduced
  3. Missing runtime CLI dependencies produce clear, actionable failure messages instead of silent breakage
**Plans**: 2 plans

Plans:
- [x] 04-01: Harden server-side integrations and shared data-path assumptions
- [x] 04-02: Add regression coverage and explicit runtime-failure handling

### Phase 5: Documentation and Validation
**Goal**: Document the dual-runtime user journey and verify the complete setup and usage path for each supported runtime.
**Depends on**: Phase 4
**Requirements**: [VER-01, VER-02]
**Success Criteria** (what must be TRUE):
  1. README and onboarding docs explain how to install and use Job Quest from Claude and Codex
  2. The repo contains a repeatable validation checklist for installation, dashboard startup, skill registration, and AI helper execution in both runtimes
  3. Future contributors can see exactly what "supported in Claude and Codex" means
**Plans**: 2 plans

Plans:
- [x] 05-01: Rewrite README and onboarding guidance for dual-runtime support
- [x] 05-02: Capture end-to-end validation steps and support criteria

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Runtime Audit and Abstraction Plan | 2/2 | Complete | 2026-04-23 |
| 2. Dual-Runtime Install Surface | 3/3 | Complete | 2026-04-22 |
| 3. Runtime-Aware AI Execution | 3/3 | Complete | 2026-04-22 |
| 4. Product Integration Hardening | 2/2 | Complete | 2026-04-22 |
| 5. Documentation and Validation | 2/2 | Complete | 2026-04-22 |
