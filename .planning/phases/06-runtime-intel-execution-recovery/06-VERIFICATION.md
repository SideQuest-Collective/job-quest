---
status: partial
---

# Phase 6 Verification

- `npm test` passes in `app/` with 4 passing tests covering the Codex dry-run command and local-date helpers.
- `bash -lc 'source lib/runtime-shell.sh; ... job_quest_run_prompt_file "$prompt" --full-auto'` prints a Codex command with both `--add-dir /tmp/job-quest-data` and `--add-dir /tmp/job-quest-references`.
- `app/server.js` no longer uses `toISOString().split('T')[0]` for server-side daily-state behavior.
- `docs/validation/dual-runtime-checklist.md` now includes installed Codex daily-intel verification and local-date endpoint checks.

## Remaining Manual Validation

- A real installed Codex environment still needs to run `~/.job-quest/bin/run-daily-intel.sh` and confirm that fresh local-day intel, quiz, and task artifacts are written under `~/.job-quest/data/`.
- The dashboard endpoints should be spot-checked in that installed environment near local day boundaries to confirm the repaired local-date contract outside the sandbox.
