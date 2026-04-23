# Runtime Coupling Audit

## Audit Scope

This audit inventories the current Claude-coupled surfaces that later compatibility phases must revisit. Every finding in this document maps back to a committed repo file so follow-on changes can stay source-linked and reviewable.

## Runtime Coupling Inventory

| Layer | File | Claude-specific assumption | Why it blocks Codex | Target follow-on phase |
| --- | --- | --- | --- | --- |
| Install | `install.sh` | Declares `~/.claude/job-quest` as the canonical product home, copies the skill to `~/.claude/skills/job-quest/SKILL.md`, and tells the user to open Claude Code and run `/job-quest`. | Codex cannot install into Claude-only roots or rely on a Claude-only slash command without a runtime-aware install and registration layer. | Pending population in Task 3. |
| Docs | `README.md` | Documents Job Quest as a Claude Code skill, uses `~/.claude/job-quest` for clone, start, uninstall, and reinstall flows, points skill registration at `~/.claude/skills/job-quest/SKILL.md`, and repeatedly tells the user to run `/job-quest`. | Later phases need runtime-neutral docs because current onboarding and filesystem examples only describe Claude conventions and would mislead Codex users. | Pending population in Task 3. |
| Skill | `skill/SKILL.md` | Reads and writes onboarding state under `~/.claude/job-quest`, references `~/.claude/job-quest/bin/...` helpers throughout, assumes the command name `/job-quest`, and uses user-facing Claude wording for onboarding, daily intel, reinstall, and helper-script descriptions. | This is the highest-density runtime coupling surface; Codex support cannot reuse the skill contract while the storage root, registration flow, and user instructions remain Claude-specific. | Pending population in Task 3. |
| Runtime launcher | `skill/bin/start.sh` | Hard-codes `APP_DIR="$HOME/.claude/job-quest/app"` and `DATA_DIR="$HOME/.claude/job-quest"` and prints the installer one-liner as the recovery path. | The dashboard launcher is pinned to a Claude-root install, so a Codex registration surface would still start the app from the wrong location. | Pending population in Task 3. |
| Scheduler | `skill/bin/install-schedule.sh` | Hard-codes `DATA_DIR="$HOME/.claude/job-quest"`, `RUNNER="$DATA_DIR/bin/run-daily-intel.sh"`, the user-facing schedule command under `~/.claude/job-quest/bin/install-schedule.sh`, and the launchd label `com.sidequest.job-quest.daily-intel`. | Runtime portability needs a shared product-home resolution path and explicit ownership of the scheduler label and runner path instead of baking Claude-root values into scheduler setup. | Pending population in Task 3. |
| Scheduled runtime | `skill/bin/run-daily-intel.sh` | Reads and writes all daily intel state under `~/.claude/job-quest`, asks the user to run `/job-quest` to finish onboarding, resolves the AI CLI as `claude` first or `npx -y @anthropic-ai/claude-code` second, and logs "Using Claude CLI". | Scheduled generation is still Claude-only at both the filesystem and command layers, so Codex cannot reuse the job without a shared runtime wrapper and neutral path contract. | Pending population in Task 3. |
| Wrapper | `skill/bin/generate-plan.sh` | Detects `claude` via `command -v claude`, falls back to `npx -y @anthropic-ai/claude-code`, and returns errors that explicitly say "Claude CLI not found". | The interview-plan wrapper is already a runtime adapter seam, but today it only knows Claude commands and Claude-branded recovery text. | Pending population in Task 3. |
| Wrapper | `skill/bin/code-review.sh` | Pipes prompts straight to `claude --print` or `npx -y @anthropic-ai/claude-code --print` and tells the user to install Claude Code when neither exists. | Code review cannot run under Codex until this wrapper stops hard-coding Claude command names and install guidance. | Pending population in Task 3. |
| Lifecycle | `skill/bin/uninstall.sh` | Removes `~/.claude/skills/job-quest`, treats `~/.claude/job-quest` as the combined app and data home, deletes temp files matching `claude_prompt_`, and removes the launchd plist at `com.sidequest.job-quest.daily-intel`. | Uninstall logic would miss any Codex registration surface and ties cleanup behavior to Claude-only temp-file and install-root conventions. | Pending population in Task 3. |
| Lifecycle | `skill/bin/reinstall.sh` | Uses `DATA_DIR="$HOME/.claude/job-quest"`, assumes reinstall starts from the Claude-root bin directory, and tells the user to run `/job-quest` in Claude Code after reinstall. | Reinstall still assumes a single Claude-oriented entrypoint, so dual-runtime lifecycle support cannot be added safely without abstracting the registration and restart flow. | Pending population in Task 3. |
| App wrapper | `app/scripts/generate-plan.sh` | Duplicates the same Claude-only runtime detection as `skill/bin/generate-plan.sh`: `claude`, then `npx -y @anthropic-ai/claude-code`, with Claude-branded logs and error text. | The dashboard server depends on an app-local copy of the same Claude-only wrapper, so runtime changes would drift unless both copies are unified. | Pending population in Task 3. |
| App wrapper | `app/scripts/code-review.sh` | Duplicates the same Claude-only `claude --print` and `npx -y @anthropic-ai/claude-code --print` logic plus Claude-specific installation guidance. | The app cannot become runtime-aware while it keeps a separate copy of the Claude-only review wrapper. | Pending population in Task 3. |
| Server | `app/server.js` | Calls app-local wrapper scripts, writes temp prompts with the prefix `claude_prompt_`, checks the scheduler plist at `com.sidequest.job-quest.daily-intel.plist`, and returns many API messages that say "Claude" or "Claude CLI". | Even if the shell wrappers are fixed later, the server still exposes Claude-only temporary-file, scheduler, and error-message conventions to the rest of the product. | Pending population in Task 3. |
| UI | `app/public/index.html` | Shows the schedule command `~/.claude/job-quest/bin/install-schedule.sh "3 7 * * 1-5"` in the dashboard and uses user-facing labels like `Claude`, `Claude Editor`, `Ask Claude`, `Generating prep plan with Claude...`, and `Check Claude CLI`. | The frontend hard-codes both the Claude-root command path and the Claude product name, so Codex support would look broken even if backend runtime selection were added. | Pending population in Task 3. |

## Duplicate Wrapper Surface

- `skill/bin/generate-plan.sh` and `app/scripts/generate-plan.sh` are byte-for-byte duplicates in the current repo. Both files detect `claude`, fall back to `npx -y @anthropic-ai/claude-code`, and return the same "Claude CLI not found" error contract.
- `skill/bin/code-review.sh` and `app/scripts/code-review.sh` are also byte-for-byte duplicates. Both wrappers pipe prompts to `claude --print` first, then to `npx -y @anthropic-ai/claude-code --print`, with identical Claude-branded failure text.
- `skill/bin/start.sh` overlaps with `app/start.sh` rather than duplicating it exactly. `app/start.sh` only changes into `app/` and runs `node server.js`, while `skill/bin/start.sh` hard-codes the `~/.claude/job-quest` app and data roots before delegating startup behavior to the embedded dashboard app.

## Follow-on Phase Impact

Pending population in Task 3.

## Verification Checklist

Pending population in Task 3.
