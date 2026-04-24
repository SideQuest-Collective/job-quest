# Phase 6: Runtime Intel Execution Recovery - Research

**Researched:** 2026-04-23
**Domain:** Installed runtime execution recovery and local-date dashboard consistency
**Confidence:** HIGH

<research_summary>
## Summary

Phase 6 is a focused recovery phase, not a broad feature phase. The repo already has the shared runtime descriptor and the installed helper surface, but two seams remain weak:

1. The installed daily intel runner still depends on the runtime wrapper, installed references, and Codex CLI invocation details all lining up in a real `~/.job-quest` environment.
2. The dashboard still treats "today" as `new Date().toISOString().split('T')[0]`, which is UTC-based and can disagree with the local date used by the user and the scheduled generator.

The planning target should therefore stay narrow and concrete:
- prove the installed Codex path from `~/.job-quest/bin/run-daily-intel.sh` through `lib/runtime-shell.sh` into `codex exec`
- normalize all daily artifact readers to one shared local-date helper
- lock in regression coverage around both the installed helper path and local date-boundary selection

**Primary recommendation:** Keep the roadmap's 3-plan split. Plan 06-01 should repair the installed Codex runner path, 06-02 should centralize local-date semantics in the server, and 06-03 should add regression coverage that exercises both seams together.
</research_summary>

<codebase_findings>
## Codebase Findings

### 1. Installed daily intel execution path

The installed runner is `skill/bin/run-daily-intel.sh`, copied into `~/.job-quest/bin/run-daily-intel.sh` by `install.sh`.

Relevant flow:
- `install.sh` copies helper scripts into `~/.job-quest/bin/`
- `run-daily-intel.sh` locates `lib/runtime-shell.sh`, calls `job_quest_load_runtime --require-registration`, builds a prompt, then invokes `job_quest_run_prompt_file`
- `lib/runtime-shell.sh` shells out to `node lib/runtime.js shell --require-runner ...` and exports the resolved runtime fields
- `job_quest_run_prompt_file()` runs either:
  - Claude: `claude --print ...`
  - Codex: `codex exec -C "$JOB_QUEST_APP_ROOT" --skip-git-repo-check --add-dir "$JOB_QUEST_DATA_DIR" ...`

This means the Codex path depends on all of these being correct in an installed environment:
- `runtime.json` active runtime and resolved command
- installed registration artifact under `~/.codex/skills/job-quest/SKILL.md`
- installed shared runner under `~/.job-quest/bin/start.sh`
- `JOB_QUEST_APP_ROOT`, `JOB_QUEST_DATA_DIR`, and `JOB_QUEST_REFERENCES_DIR` exports from `lib/runtime.js`
- Codex CLI flags being compatible with the intended automated file-writing flow

### 2. Daily artifact readers are UTC-based today

The server endpoints currently use `new Date().toISOString().split('T')[0]` inline:
- `/api/quizzes/today`
- `/api/tasks/today`
- `/api/job-status`
- activity logging and auto-complete helpers also use the same UTC date pattern

This is risky because:
- `toISOString()` converts to UTC, not the user's local day
- the scheduled runner and dashboard are conceptually local-user workflows
- just after local midnight or near UTC day rollover, generated files and dashboard readers can disagree about which artifact is "today"

### 3. `/api/intel/latest` does not explicitly align to local-day semantics

`/api/intel/latest` currently returns `readDataDir('intel')[0] || null`.

If `readDataDir()` sorts by filename date descending, this may often return the latest file, but it does not guarantee the same contract as the "today" endpoints. Phase 6 should decide whether:
- `/api/intel/latest` remains "latest available artifact" while `/api/job-status` uses local-today readiness, or
- it first prefers the local-today artifact and otherwise falls back to latest

The roadmap language suggests these surfaces should agree under local-date semantics, so the plan should make that contract explicit.
</codebase_findings>

<likely_files>
## Likely Files and Surfaces

### Runtime execution
- `skill/bin/run-daily-intel.sh`
- `lib/runtime-shell.sh`
- `lib/runtime.js`
- `install.sh`
- `skill/SKILL.md`
- `docs/validation/dual-runtime-checklist.md`

### Dashboard date handling
- `app/server.js`
- possibly shared helpers under `app/` if a date utility is introduced

### Tests / validation
- existing test files under `app/` and/or repo root if present
- new regression tests for date helpers and helper invocation seams
</likely_files>

<recommended_plan_shape>
## Recommended Plan Shape

### 06-01: Repair installed Codex daily intel execution
- Read the installed runner path end to end from `install.sh` through `run-daily-intel.sh`, `lib/runtime-shell.sh`, and `lib/runtime.js`
- Identify the exact Codex failure mode in an installed environment instead of patching speculatively
- Make the runtime invocation contract explicit for Codex, including working directory, writable dirs, and expected automation flags
- Ensure failure logging names the active runtime and the failing step clearly

### 06-02: Normalize dashboard daily artifact selection
- Introduce one shared local-date helper for server-side "today"
- Replace inline UTC date calculations in `/api/job-status`, `/api/quizzes/today`, `/api/tasks/today`, and other daily-state helpers that participate in dashboard readiness
- Decide and document how `/api/intel/latest` should behave relative to local-today vs latest-available fallback

### 06-03: Add regression coverage
- Add automated coverage for the Codex helper path at the shell/runtime boundary
- Add automated coverage proving local-date behavior across the daily endpoints
- Update the validation checklist so Phase 7 can rely on concrete runtime/date evidence instead of manual inference
</recommended_plan_shape>

<risks>
## Risks and Pitfalls

### Pitfall 1: Fixing the helper by hard-coding more Codex assumptions
The repo already has a shared runtime contract. Phase 6 should repair the installed Codex path through that contract, not by adding one-off Codex conditionals in multiple scripts.

### Pitfall 2: Fixing only one endpoint's date logic
If only `/api/job-status` changes, the dashboard can still disagree because `/api/quizzes/today` and `/api/tasks/today` remain UTC-based. The fix needs one shared local-date path.

### Pitfall 3: Treating "latest" and "today" as interchangeable without deciding the contract
`/api/intel/latest` is not automatically the same as "today". Phase 6 should define the exact fallback behavior so the UI does not drift again later.

### Pitfall 4: Relying only on repo-local execution
The bug is specifically about the installed Codex environment. At least one regression path should model the installed `~/.job-quest/bin/run-daily-intel.sh` flow or the closest possible shell-level equivalent.
</risks>

## Validation Architecture

The phase should be validated at three levels:

1. Runtime wrapper coverage
- Prove the Codex invocation path resolves the expected command, cwd, and writable data dir
- Prove error handling is explicit when runtime registration or runner prerequisites are missing

2. Server daily-date coverage
- Prove the daily endpoints use one local-date helper instead of inline UTC date strings
- Prove boundary cases around timezone-sensitive dates select the correct artifact

3. Installed-flow validation evidence
- Prove the manual validation checklist includes the repaired Codex daily intel path
- Keep the checklist aligned with the actual installed paths under `~/.job-quest`

Fast verification should include:
- targeted automated tests for the date helper and endpoint selection logic
- targeted tests or shell-level coverage for runtime invocation construction
- grep/read checks that the validation docs reference the installed runner and expected artifacts

<sources>
## Sources

### Primary (HIGH confidence)
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `.planning/phases/05-documentation-and-validation/05-CONTEXT.md`
- `.planning/phases/05-documentation-and-validation/05-VERIFICATION.md`
- `install.sh`
- `skill/bin/run-daily-intel.sh`
- `lib/runtime-shell.sh`
- `lib/runtime.js`
- `app/server.js`
- `docs/validation/dual-runtime-checklist.md`

### Secondary (MEDIUM confidence)
- `skill/SKILL.md`
- `docs/runtime/runtime-coupling-audit.md`
</sources>
