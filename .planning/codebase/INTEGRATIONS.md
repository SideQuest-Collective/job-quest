# External Integrations

**Analysis Date:** 2026-04-21

## APIs & External Services

**AI Runtime via Local CLI:**
- Anthropic Claude Code - Used for interview-plan generation, answer evaluation, behavioral draft generation, code review, resume edit prompts, and daily intel generation
  - SDK/Client: local `claude` executable or `npx -y @anthropic-ai/claude-code` in `app/scripts/generate-plan.sh`, `app/scripts/code-review.sh`, and `skill/bin/run-daily-intel.sh`
  - Auth: no env var is read in repo code; authentication is delegated to the installed Claude CLI outside this repo
  - Note: this is a local CLI dependency, not a direct HTTP API integration in `app/server.js`

**Source Code Distribution:**
- GitHub repository `SideQuest-Collective/job-quest` - Installation and updates pull code into `~/.claude/job-quest`
  - SDK/Client: `git clone`, `git pull`, and `curl` in `install.sh` and `skill/bin/reinstall.sh`
  - Auth: none for public install paths

**Package Distribution:**
- npm registry - Used for app dependency install and CLI fallback execution
  - SDK/Client: `npm install` in `install.sh`; `npx -y @anthropic-ai/claude-code` in `app/scripts/*.sh` and `skill/bin/*.sh`
  - Auth: none configured in repo

**Browser-loaded Frontend Assets:**
- cdnjs - Loads React, ReactDOM, Babel standalone, Marked, PDF.js, and Ace directly in `app/public/index.html`
  - SDK/Client: direct `<script src="https://cdnjs.cloudflare.com/...">` tags
  - Auth: none
- Google Fonts - Loads `Outfit` and `JetBrains Mono` in `app/public/index.html`
  - SDK/Client: direct `<link href="https://fonts.googleapis.com/...">`
  - Auth: none

**Local OS Services:**
- macOS `launchd` and Linux `crontab` - Schedule the daily intel job from `skill/bin/install-schedule.sh`
  - SDK/Client: shell commands plus `launchctl` and `crontab`
  - Auth: local user account permissions only
  - Note: this is a local machine integration, not a remote service

## Data Storage

**Databases:**
- Local JSON files only
  - Connection: `DATA_DIR` resolved in `app/server.js`
  - Client: Node `fs` module in `app/server.js`
  - Paths: daily intel under `DATA_DIR/intel/`, quizzes under `DATA_DIR/quizzes/`, tasks under `DATA_DIR/tasks/`, coding data under `DATA_DIR/problems/`, and profile/progress files at the `DATA_DIR` root

**File Storage:**
- Local filesystem only
  - Runtime install/data root: `~/.claude/job-quest/` via `install.sh`
  - Development fallback root: `app/data/` when `DATA_DIR` is unset in `app/server.js`
  - Resume assets: `DATA_DIR/resume-files/` in `app/server.js`
  - Conversation history: `DATA_DIR/conversations/` and `DATA_DIR/sd-conversations/` in `app/server.js`

**Caching:**
- None detected

## Authentication & Identity

**Auth Provider:**
- None for the local dashboard
  - Implementation: `app/server.js` exposes local APIs without user/session auth

**Runtime Identity Registration:**
- Claude Code skill registration in `~/.claude/skills/job-quest/SKILL.md`
  - Implementation: `install.sh` copies `skill/SKILL.md` into the Claude-specific skill directory
  - Note: this is runtime registration, not end-user authentication

## Monitoring & Observability

**Error Tracking:**
- None detected

**Logs:**
- Local log files only
  - `skill/bin/run-daily-intel.sh` writes `DATA_DIR/logs/daily-intel.log`
  - `skill/bin/generate-plan.sh` writes `../logs/plan-generation.log`
  - `app/server.js` uses console logging for request-specific AI workflows and server startup

## CI/CD & Deployment

**Hosting:**
- Local machine only
  - Dashboard server: `app/server.js`
  - Launcher: `skill/bin/start.sh` or `app/start.sh`
  - Default URL: `http://localhost:3847`

**CI Pipeline:**
- None detected in the repository root; no `.github/workflows/` or alternative CI config is present

## Environment Configuration

**Required env vars:**
- `DATA_DIR` - Main storage root for installed usage, consumed by `app/server.js`
- `PORT` - Optional port override for `app/server.js`
- `HOME` - Used by install and wrapper scripts to resolve `~/.claude/job-quest`
- `PATH` - Used by `app/server.js`, `app/scripts/*.sh`, and `skill/bin/*.sh` to find `node`, `python3`, `tectonic`, `claude`, `npx`, `launchctl`, and `crontab`
- `NVM_DIR` - Optional Node resolution path loaded by `app/scripts/*.sh` and `skill/bin/*.sh`

**Secrets location:**
- Not detected in repo-managed configuration
- `app/.env` exists and is installer-managed for path configuration; this analysis does not read or rely on its contents
- Claude CLI credentials, if present on the machine, are managed outside this repository and are not referenced directly by code

## Webhooks & Callbacks

**Incoming:**
- None detected
- Local scheduled invocation only: `skill/bin/install-schedule.sh` schedules `skill/bin/run-daily-intel.sh`

**Outgoing:**
- None from `app/server.js` as direct HTTP client code
- Indirect outbound activity occurs through local tools:
  - `claude` / `npx -y @anthropic-ai/claude-code` in `app/scripts/*.sh` and `skill/bin/run-daily-intel.sh`
  - `git clone`, `git pull`, and `curl` in `install.sh` and `skill/bin/reinstall.sh`
  - CDN and font fetches by the browser from `app/public/index.html`

---

*Integration audit: 2026-04-21*
