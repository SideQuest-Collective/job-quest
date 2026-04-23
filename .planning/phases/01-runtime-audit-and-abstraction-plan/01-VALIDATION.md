---
phase: 01
slug: runtime-audit-and-abstraction-plan
status: draft
nyquist_compliant: false
wave_0_complete: true
created: 2026-04-22
---

# Phase 01 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | shell + `rg` artifact checks |
| **Config file** | none - direct CLI verification against docs and JSON artifacts |
| **Quick run command** | `rg -n "Runtime Coupling Inventory|Duplicate Wrapper Surface|Follow-on Phase Impact" docs/runtime/runtime-coupling-audit.md` |
| **Full suite command** | `rg -n "schemaVersion|activeRuntime|productHomeDir|runtimeRegistrationRoot|runtimeCommand|runtimeSwitchPolicy" docs/runtime/runtime-contract.md docs/runtime/runtime-config-example.json docs/runtime/runtime-migration.md` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run the task-specific `rg` check from the plan
- **After every plan wave:** Run the full suite command
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | RT-03 | T-01-01 | Audit captures every runtime-coupled surface with exact file references | docs | `rg -n "install.sh|README.md|skill/SKILL.md|skill/bin/start.sh|skill/bin/install-schedule.sh|skill/bin/run-daily-intel.sh|app/server.js|app/public/index.html" docs/runtime/runtime-coupling-audit.md` | W0 missing | pending |
| 01-01-02 | 01 | 1 | RT-03 | T-01-02 | Duplicate wrapper pairs and runtime literals are explicitly documented | docs | `rg -n "Duplicate Wrapper Surface|app/scripts/generate-plan.sh|skill/bin/generate-plan.sh|@anthropic-ai/claude-code|~/.claude/job-quest" docs/runtime/runtime-coupling-audit.md` | W0 missing | pending |
| 01-02-01 | 02 | 2 | RT-03 | T-01-03 | Runtime contract defines the shared config shape and CLI/path semantics | docs | `rg -n "schemaVersion|activeRuntime|productHomeDir|dataDir|runtimeRegistrationRoot|runtimeCommand|runtimeSwitchPolicy" docs/runtime/runtime-contract.md` | W0 missing | pending |
| 01-02-02 | 02 | 2 | RT-03 | T-01-04 | Config example covers Claude and Codex runtime metadata without duplicating shared data roots | docs | `rg -n "\"activeRuntime\"|\"productHomeDir\"|\"supportedRuntimes\"|\"claude\"|\"codex\"" docs/runtime/runtime-config-example.json` | W0 missing | pending |
| 01-02-03 | 02 | 2 | RT-03 | T-01-04 | Migration guide documents legacy Claude handling and automatic runtime switching | docs | `rg -n "~/.claude/job-quest|~/.job-quest|automatic runtime switch|legacy Claude install|no-breakage" docs/runtime/runtime-migration.md` | W0 missing | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all missing references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
