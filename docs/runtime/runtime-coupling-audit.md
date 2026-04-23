# Runtime Coupling Audit

## Audit Scope

This audit inventories the current Claude-coupled surfaces that later compatibility phases must revisit. Every finding in this document maps back to a committed repo file so follow-on changes can stay source-linked and reviewable, and the scope now covers every repo-visible Claude-coupled documentation surface, including the app-local README.

## Runtime Coupling Inventory

| Layer | File | Claude-specific assumption | Why it blocks Codex | Target follow-on phase |
| --- | --- | --- | --- | --- |
| Install | `install.sh` | Declares `~/.claude/job-quest` as the canonical product home, copies the skill to `~/.claude/skills/job-quest/SKILL.md`, and tells the user to open Claude Code and run `/job-quest`. | Codex cannot install into Claude-only roots or rely on a Claude-only slash command without a runtime-aware install and registration layer. | Phase 2 install and registration |
| Docs | `README.md` | Documents Job Quest as a Claude Code skill, uses `~/.claude/job-quest` for clone, start, uninstall, and reinstall flows, points skill registration at `~/.claude/skills/job-quest/SKILL.md`, and repeatedly tells the user to run `/job-quest`. | Later phases need runtime-neutral docs because current onboarding and filesystem examples only describe Claude conventions and would mislead Codex users. | Phase 5 docs and validation |
| Docs | `app/README.md` | Describes `AI Code Review -- Get feedback on your solutions via the Claude CLI`, lists `[Claude CLI](https://github.com/anthropics/claude-code)` as an optional prerequisite for code review and interview-plan generation, labels `scripts/           # Helper scripts (Claude CLI wrapper)`, and documents `POST /api/code-review | AI code review via Claude`. | This embedded app-level README would continue telling users and contributors that the app's AI features are Claude-only even after dual-runtime support lands elsewhere. | Phase 5 docs and validation |
| Skill | `skill/SKILL.md` | Reads and writes onboarding state under `~/.claude/job-quest`, references `~/.claude/job-quest/bin/...` helpers throughout, assumes the command name `/job-quest`, and uses user-facing Claude wording for onboarding, daily intel, reinstall, and helper-script descriptions. | This is the highest-density runtime coupling surface; Codex support cannot reuse the skill contract while the storage root, registration flow, and user instructions remain Claude-specific. | Phase 2 install and registration |
| Runtime launcher | `skill/bin/start.sh` | Hard-codes `APP_DIR="$HOME/.claude/job-quest/app"` and `DATA_DIR="$HOME/.claude/job-quest"` and prints the installer one-liner as the recovery path. | The dashboard launcher is pinned to a Claude-root install, so a Codex registration surface would still start the app from the wrong location. | Phase 4 hardening and UX |
| Scheduler | `skill/bin/install-schedule.sh` | Hard-codes `DATA_DIR="$HOME/.claude/job-quest"`, `RUNNER="$DATA_DIR/bin/run-daily-intel.sh"`, the user-facing schedule command under `~/.claude/job-quest/bin/install-schedule.sh`, and the launchd label `com.sidequest.job-quest.daily-intel`. | Runtime portability needs a shared product-home resolution path and explicit ownership of the scheduler label and runner path instead of baking Claude-root values into scheduler setup. | Phase 3 runtime execution |
| Scheduled runtime | `skill/bin/run-daily-intel.sh` | Reads and writes all daily intel state under `~/.claude/job-quest`, asks the user to run `/job-quest` to finish onboarding, resolves the AI CLI as `claude` first or `npx -y @anthropic-ai/claude-code` second, and logs "Using Claude CLI". | Scheduled generation is still Claude-only at both the filesystem and command layers, so Codex cannot reuse the job without a shared runtime wrapper and neutral path contract. | Phase 3 runtime execution |
| Wrapper | `skill/bin/generate-plan.sh` | Detects `claude` via `command -v claude`, falls back to `npx -y @anthropic-ai/claude-code`, and returns errors that explicitly say "Claude CLI not found". | The interview-plan wrapper is already a runtime adapter seam, but today it only knows Claude commands and Claude-branded recovery text. | Phase 3 runtime execution |
| Wrapper | `skill/bin/code-review.sh` | Pipes prompts straight to `claude --print` or `npx -y @anthropic-ai/claude-code --print` and tells the user to install Claude Code when neither exists. | Code review cannot run under Codex until this wrapper stops hard-coding Claude command names and install guidance. | Phase 3 runtime execution |
| Lifecycle | `skill/bin/uninstall.sh` | Removes `~/.claude/skills/job-quest`, treats `~/.claude/job-quest` as the combined app and data home, deletes temp files matching `claude_prompt_`, and removes the launchd plist at `com.sidequest.job-quest.daily-intel`. | Uninstall logic would miss any Codex registration surface and ties cleanup behavior to Claude-only temp-file and install-root conventions. | Phase 2 install and registration |
| Lifecycle | `skill/bin/reinstall.sh` | Uses `DATA_DIR="$HOME/.claude/job-quest"`, assumes reinstall starts from the Claude-root bin directory, and tells the user to run `/job-quest` in Claude Code after reinstall. | Reinstall still assumes a single Claude-oriented entrypoint, so dual-runtime lifecycle support cannot be added safely without abstracting the registration and restart flow. | Phase 2 install and registration |
| App wrapper | `app/scripts/generate-plan.sh` | Duplicates the same Claude-only runtime detection as `skill/bin/generate-plan.sh`: `claude`, then `npx -y @anthropic-ai/claude-code`, with Claude-branded logs and error text. | The dashboard server depends on an app-local copy of the same Claude-only wrapper, so runtime changes would drift unless both copies are unified. | Phase 3 runtime execution |
| App wrapper | `app/scripts/code-review.sh` | Duplicates the same Claude-only `claude --print` and `npx -y @anthropic-ai/claude-code --print` logic plus Claude-specific installation guidance. | The app cannot become runtime-aware while it keeps a separate copy of the Claude-only review wrapper. | Phase 3 runtime execution |
| Server | `app/server.js` | Calls app-local wrapper scripts, writes temp prompts with the prefix `claude_prompt_`, checks the scheduler plist at `com.sidequest.job-quest.daily-intel.plist`, and returns many API messages that say "Claude" or "Claude CLI". | Even if the shell wrappers are fixed later, the server still exposes Claude-only temporary-file, scheduler, and error-message conventions to the rest of the product. | Phase 4 hardening and UX |
| UI | `app/public/index.html` | Shows the schedule command `~/.claude/job-quest/bin/install-schedule.sh "3 7 * * 1-5"` in the dashboard and uses user-facing labels like `Claude`, `Claude Editor`, `Ask Claude`, `Generating prep plan with Claude...`, and `Check Claude CLI`. | The frontend hard-codes both the Claude-root command path and the Claude product name, so Codex support would look broken even if backend runtime selection were added. | Phase 4 hardening and UX |

## Duplicate Wrapper Surface

- `skill/bin/generate-plan.sh` and `app/scripts/generate-plan.sh` are byte-for-byte duplicates in the current repo. Both files detect `claude`, fall back to `npx -y @anthropic-ai/claude-code`, and return the same "Claude CLI not found" error contract.
- `skill/bin/code-review.sh` and `app/scripts/code-review.sh` are also byte-for-byte duplicates. Both wrappers pipe prompts to `claude --print` first, then to `npx -y @anthropic-ai/claude-code --print`, with identical Claude-branded failure text.
- `skill/bin/start.sh` overlaps with `app/start.sh` rather than duplicating it exactly. `app/start.sh` only changes into `app/` and runs `node server.js`, while `skill/bin/start.sh` hard-codes the `~/.claude/job-quest` app and data roots before delegating startup behavior to the embedded dashboard app.

## Follow-on Phase Impact

### Phase 2 install and registration

- `install.sh`: replace the Claude-root install and skill-registration targets with runtime-aware path resolution while keeping existing Claude installs working.
- `skill/SKILL.md`: split runtime-neutral product behavior from Claude-only registration and onboarding instructions.
- `skill/bin/uninstall.sh`: teach lifecycle cleanup about shared product state and non-Claude registration edges.
- `skill/bin/reinstall.sh`: route reinstall through the same dual-runtime install contract instead of returning users only to Claude Code.

### Phase 3 runtime execution

- `skill/bin/install-schedule.sh`: move scheduler path and label resolution behind the shared runtime contract.
- `skill/bin/run-daily-intel.sh`: replace direct Claude CLI lookup with the shared runtime wrapper and neutral product-home paths.
- `skill/bin/generate-plan.sh`: consolidate its Claude-only command selection into the shared runtime execution layer.
- `skill/bin/code-review.sh`: do the same for code-review execution and error handling.
- `app/scripts/generate-plan.sh`: remove the duplicated app-local wrapper in favor of shared runtime execution logic.
- `app/scripts/code-review.sh`: remove the duplicated app-local review wrapper for the same reason.
- `app/server.js`: point server-triggered AI flows and schedule checks at the new runtime-aware execution layer.

### Phase 4 hardening and UX

- `skill/bin/start.sh`: stop assuming the dashboard always lives under `~/.claude/job-quest` and make launcher failure modes explicit.
- `skill/bin/install-schedule.sh`: verify the scheduler still works cleanly after runtime abstraction and surface clearer failure messaging where needed.
- `skill/bin/uninstall.sh`: confirm cleanup, temp-file removal, and scheduler teardown remain safe after the path migration.
- `app/server.js`: replace Claude-branded API failures and temp-file conventions that leak into product behavior.
- `app/public/index.html`: remove Claude-only UI labels, commands, and runtime-specific recovery copy from the dashboard.

### Phase 5 docs and validation

- `README.md`: rewrite installation, daily use, and lifecycle docs so Claude and Codex are both first-class supported runtimes.
- `app/README.md`: rewrite the embedded app guide so prerequisites, helper-script descriptions, and API notes no longer describe AI features as Claude-only.
- `skill/SKILL.md`: align the documented user journey with the dual-runtime contract after implementation lands.
- `app/public/index.html`: validate that surfaced commands and runtime wording match the supported user guidance.

## Verification Checklist

- This checklist now covers every repo-visible Claude-coupled documentation surface, including the app-local README, so later phases can prove the audit is exhaustive before rewriting user-facing guidance.
- `install.sh`: grep for `~/.claude/job-quest`, `~/.claude/skills/job-quest/SKILL.md`, and `/job-quest`.
- `README.md`: grep for `~/.claude/job-quest`, `~/.claude/skills/job-quest/SKILL.md`, `Claude Code`, and `/job-quest`.
- `app/README.md`: grep for `Claude CLI`, `Claude CLI wrapper`, and `AI code review via Claude`.
- `skill/SKILL.md`: grep for `~/.claude/job-quest`, `/job-quest`, `Claude`, and `claude -p`.
- `skill/bin/start.sh`: grep for `$HOME/.claude/job-quest/app` and `$HOME/.claude/job-quest`.
- `skill/bin/install-schedule.sh`: grep for `~/.claude/job-quest/bin/install-schedule.sh`, `$HOME/.claude/job-quest`, and `com.sidequest.job-quest.daily-intel`.
- `skill/bin/run-daily-intel.sh`: grep for `$HOME/.claude/job-quest`, `/job-quest`, `claude`, and `@anthropic-ai/claude-code`.
- `skill/bin/generate-plan.sh`: grep for `command -v claude`, `npx -y @anthropic-ai/claude-code`, and `Claude CLI not found`.
- `skill/bin/code-review.sh`: grep for `claude --print`, `npx -y @anthropic-ai/claude-code --print`, and `Install Claude Code`.
- `skill/bin/uninstall.sh`: grep for `~/.claude/job-quest`, `~/.claude/skills/job-quest`, `claude_prompt_`, and `com.sidequest.job-quest.daily-intel`.
- `skill/bin/reinstall.sh`: grep for `~/.claude/job-quest`, `/job-quest`, and `Claude Code`.
- `app/scripts/generate-plan.sh`: grep for `command -v claude`, `npx -y @anthropic-ai/claude-code`, and `Claude CLI not found`.
- `app/scripts/code-review.sh`: grep for `claude --print`, `npx -y @anthropic-ai/claude-code --print`, and `Install Claude Code`.
- `app/server.js`: grep for `claude_prompt_`, `Claude`, `Claude CLI`, and `com.sidequest.job-quest.daily-intel.plist`.
- `app/public/index.html`: grep for `~/.claude/job-quest/bin/install-schedule.sh`, `Claude`, `Claude Editor`, and `Ask Claude`.
