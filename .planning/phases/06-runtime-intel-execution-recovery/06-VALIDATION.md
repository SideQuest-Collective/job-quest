---
phase: 06
slug: runtime-intel-execution-recovery
status: partial
nyquist_compliant: false
wave_0_complete: true
created: 2026-04-24
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node built-in test runner (`node:test`) |
| **Config file** | none |
| **Quick run command** | `cd app && npm test` |
| **Full suite command** | `cd app && npm test` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd app && npm test`
- **After every plan wave:** Run `cd app && npm test`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | RT-02 | T-06-01 | Codex dry-run command includes `-C`, `--add-dir $JOB_QUEST_DATA_DIR`, and `--add-dir $JOB_QUEST_REFERENCES_DIR` | integration | `cd app && npm test` | ✅ `app/tests/runtime-shell.test.js` | ✅ green |
| 06-01-02 | 01 | 1 | RT-02 | T-06-02 | Installed `run-daily-intel.sh` logs resolved runtime/app/data/reference paths during a real Codex-installed run | manual | — | ❌ | ⚠️ manual-only |
| 06-02-01 | 02 | 1 | PROD-01 | T-06-03 | Local date helper returns `YYYY-MM-DD` from local calendar values and prefers today's record before fallback | unit | `cd app && npm test` | ✅ `app/tests/local-date.test.js` | ✅ green |
| 06-02-02 | 02 | 1 | PROD-01 | T-06-03 / T-06-04 | `/api/job-status`, `/api/intel/latest`, `/api/quizzes/today`, and `/api/tasks/today` agree on same local-day artifacts when today's files exist | integration | `cd app && npm test` | ✅ `app/tests/server-daily-state.test.js` | ✅ green |
| 06-03-01 | 03 | 2 | RT-02 | T-06-05 | Regression suite preserves the repaired Codex dry-run command shape | integration | `cd app && npm test` | ✅ `app/tests/runtime-shell.test.js` | ✅ green |
| 06-03-02 | 03 | 2 | PROD-01 | T-06-06 | Regression suite preserves local-date endpoint fallback behavior when today's files are missing | integration | `cd app && npm test` | ✅ `app/tests/server-daily-state.test.js` | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ manual-only*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real installed Codex daily intel run writes fresh same-day artifacts under `~/.job-quest/data/` | RT-02 | The sandbox cannot exercise the real shared product home and installed `~/.job-quest/bin/run-daily-intel.sh` end-to-end | Run `~/.job-quest/bin/run-daily-intel.sh` in a Codex-installed environment, then confirm fresh files exist in `~/.job-quest/data/intel/`, `~/.job-quest/data/quizzes/`, and `~/.job-quest/data/tasks/` for the same local day |
| Dashboard routes stay aligned near a real local day boundary | PROD-01 | Automated tests cover same-day and fallback selection, but they do not simulate a live near-midnight installed environment | Near a local day boundary, compare `/api/job-status`, `/api/intel/latest`, `/api/quizzes/today`, and `/api/tasks/today` against the actual artifact filenames in `~/.job-quest/data/` |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or explicit manual-only coverage
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending manual-only validation
