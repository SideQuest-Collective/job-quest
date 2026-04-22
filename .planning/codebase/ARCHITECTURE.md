# Architecture

**Analysis Date:** 2026-04-21

## Pattern Overview

**Overall:** Local-first monolith with an embedded single-page frontend and shell-based runtime adapters.

**Key Characteristics:**
- `app/server.js` is the single backend entry point and contains nearly all HTTP routes, persistence helpers, scheduler detection, and AI integration orchestration.
- `app/public/index.html` is a single-file React SPA loaded from a CDN and served as static assets by the Express server.
- Runtime-specific behavior is not isolated behind an internal interface; Claude coupling is spread across `install.sh`, `skill/SKILL.md`, `skill/bin/*.sh`, `app/scripts/*.sh`, `app/server.js`, and UI copy inside `app/public/index.html`.

## Layers

**Installer and runtime packaging layer:**
- Purpose: Clone or update the repo into the user install directory, install dependencies, seed local data, register the skill, and copy helper scripts into the install root.
- Location: `install.sh`
- Contains: Git bootstrap logic, Node prerequisite checks, `.env` generation for `app/`, skill registration into `~/.claude/skills/job-quest/`, and data-directory seeding.
- Depends on: GitHub repo clone, `npm`, filesystem layout under `~/.claude/`.
- Used by: First-time install and reinstall flow from `skill/bin/reinstall.sh`.

**Skill and runtime-integration layer:**
- Purpose: Define the conversational `/job-quest` experience and wrap Claude CLI workflows for daily intel, scheduling, review, and lifecycle management.
- Location: `skill/SKILL.md`, `skill/bin/start.sh`, `skill/bin/run-daily-intel.sh`, `skill/bin/install-schedule.sh`, `skill/bin/uninstall.sh`, `skill/bin/reinstall.sh`, `skill/bin/generate-plan.sh`, `skill/bin/code-review.sh`, `skill/references/intel-agent-template.md`
- Contains: Skill instructions, scheduled-agent prompt template, shell entrypoints, and install/uninstall helpers.
- Depends on: Claude conventions such as `~/.claude/skills/job-quest/SKILL.md`, `claude` or `npx -y @anthropic-ai/claude-code`, and the installed repo under `~/.claude/job-quest/`.
- Used by: Claude Code invocation, local scheduler, reinstall/uninstall flows, and end users launching the dashboard from the install directory.

**Web server and application layer:**
- Purpose: Serve the dashboard UI, expose JSON APIs, read and write local state, and broker requests to Claude-backed helper scripts.
- Location: `app/server.js`
- Contains: Express server setup, `DATA_DIR` resolution, JSON file persistence helpers, feature routes for intel, tasks, quizzes, applications, interview prep, behavioral prep, code lab, system design, resume management, and scheduler status.
- Depends on: `express`, `adm-zip`, Node built-ins, filesystem state under `DATA_DIR`, and shell scripts under `app/scripts/`.
- Used by: `app/start.sh`, `skill/bin/start.sh`, and every browser interaction with the dashboard.

**Frontend presentation layer:**
- Purpose: Render the command center UI and call backend APIs directly from the browser.
- Location: `app/public/index.html`
- Contains: All CSS, React components, API helpers, page navigation, and feature-specific UI logic.
- Depends on: CDN-hosted React/ReactDOM/Babel/Marked, the Express static server, and `/api/*` endpoints from `app/server.js`.
- Used by: Browser clients at `http://localhost:3847`.

**Filesystem persistence layer:**
- Purpose: Act as the system of record for user profile, daily intel, progress, conversations, and uploaded resume artifacts.
- Location: install root seeded by `install.sh` and resolved at runtime by `app/server.js` via `DATA_DIR`
- Contains: `intel/`, `quizzes/`, `tasks/`, `problems/`, `behavioral/`, `conversations/`, `sd-conversations/`, `resume-files/`, plus top-level JSON files like `profile.json`, `progress.json`, `activity.json`, `role-tracker.json`, and `role-actions.json`.
- Depends on: Local filesystem access only.
- Used by: The web app, scheduled intel generation, and skill onboarding.

## Data Flow

**Dashboard read/write flow:**

1. `skill/bin/start.sh` or `app/start.sh` launches `app/server.js`, which resolves `DATA_DIR` and serves `app/public/index.html`.
2. The React app in `app/public/index.html` calls `/api/*` endpoints such as `/api/tasks/today`, `/api/quizzes/today`, `/api/intel`, `/api/resume`, and `/api/role-tracker`.
3. `app/server.js` reads or writes JSON files under `DATA_DIR`, then returns the result directly to the frontend with minimal transformation.

**AI-assisted interactive flow:**

1. The frontend posts to endpoints such as `/api/interview-plan`, `/api/evaluate-answer`, `/api/behavioral/generate-draft`, `/api/code-review`, `/api/sd-conversation/:topicId`, or `/api/resume/edit` in `app/server.js`.
2. `app/server.js` writes a temp prompt file under `/tmp`, then shells out to `app/scripts/generate-plan.sh` or `app/scripts/code-review.sh`.
3. Those scripts invoke `claude` or `npx -y @anthropic-ai/claude-code`, and the server parses the response before saving conversation state or returning it to the browser.

**Scheduled intel flow:**

1. `skill/bin/install-schedule.sh` installs either a launchd agent or a crontab entry that runs `skill/bin/run-daily-intel.sh`.
2. `skill/bin/run-daily-intel.sh` reads `profile.json` and `references/intel-agent-template.md`, then invokes Claude with filesystem and web-search tools enabled.
3. The generated files are written into `DATA_DIR/intel/`, `DATA_DIR/quizzes/`, `DATA_DIR/tasks/`, and `DATA_DIR/problems/problems.json`, which the dashboard later reads through `app/server.js`.

**State Management:**
- Server state is primarily file-backed JSON under `DATA_DIR`.
- In-memory state is used only as a short-lived cache for active conversations in `conversations` and `sdConversations` inside `app/server.js`; durable copies are written to `DATA_DIR/conversations/` and `DATA_DIR/sd-conversations/`.
- Frontend state is local React state inside `app/public/index.html` and is refreshed by direct fetches to server endpoints.

## Key Abstractions

**`DATA_DIR` as install root and datastore:**
- Purpose: Collapse app data, generated content, logs, conversations, and uploaded files into one local root.
- Examples: `app/server.js`, `install.sh`, `skill/bin/start.sh`, `skill/bin/run-daily-intel.sh`
- Pattern: Resolve once, then build feature-specific file paths by joining subdirectories and filenames.

**Shell script adapters for AI runtime calls:**
- Purpose: Keep CLI invocation details out of route handlers while still using Claude CLI synchronously.
- Examples: `app/scripts/generate-plan.sh`, `app/scripts/code-review.sh`, `skill/bin/generate-plan.sh`, `skill/bin/code-review.sh`
- Pattern: Write prompt to temp file or stdin, invoke `claude` or `npx`, and return raw stdout back to the caller.

**Feature-by-directory persistence:**
- Purpose: Store each product area in its own JSON file or directory rather than behind a database abstraction.
- Examples: `DATA_DIR/tasks/*.json`, `DATA_DIR/quizzes/*.json`, `DATA_DIR/intel/*.json`, `DATA_DIR/problems/problems.json`, `DATA_DIR/resume-files/`
- Pattern: Routes read full JSON documents, update them in place, and write whole files back to disk.

**Single-file UI modules inside one HTML document:**
- Purpose: Keep all frontend implementation in one served file rather than a compiled asset pipeline.
- Examples: `app/public/index.html`
- Pattern: Declare `api` helpers and many React function components in one Babel-transpiled document, with page switching handled in the top-level `App()` component.

## Entry Points

**Installer bootstrap:**
- Location: `install.sh`
- Triggers: Manual install from the README one-liner or direct shell execution.
- Responsibilities: Clone/update repo, run `npm install` in `app/`, write `app/.env`, register the Claude skill, copy runtime scripts, and seed local data files.

**Skill entrypoint:**
- Location: `skill/SKILL.md`
- Triggers: `/job-quest` in Claude Code after the skill is registered.
- Responsibilities: Drive onboarding, read and write install-root files, instruct the user flow, and route install-management actions to scripts in `~/.claude/job-quest/bin/`.

**Dashboard launcher:**
- Location: `skill/bin/start.sh` and `app/start.sh`
- Triggers: Manual dashboard start from the install directory or the app directory.
- Responsibilities: Set `DATA_DIR` when using the installed flow and start `app/server.js`.

**Server runtime:**
- Location: `app/server.js`
- Triggers: `node server.js` from `app/start.sh` or `skill/bin/start.sh`
- Responsibilities: Serve static files, expose all API routes, persist state, launch helper scripts, inspect the local schedule, and listen on port `3847` by default.

**Scheduled daily agent:**
- Location: `skill/bin/run-daily-intel.sh`
- Triggers: launchd, cron, or manual execution.
- Responsibilities: Build the daily intel prompt from `profile.json`, call Claude with write access, and refresh generated content files for the dashboard.

## Error Handling

**Strategy:** Local best-effort handling with fallback JSON responses and minimal shared abstraction.

**Patterns:**
- Missing JSON files typically return empty objects or arrays instead of failing, for example in `app/server.js` routes for applications, resume, role tracker, problems, and conversations.
- AI-backed endpoints shell out, then attempt multiple response-parsing strategies before falling back to raw markdown or generic error payloads, as seen in `/api/interview-plan`, `/api/evaluate-answer`, and `/api/behavioral/generate-draft` in `app/server.js`.
- File-path-sensitive resume routes enforce path containment with `path.resolve(...).startsWith(path.resolve(RESUME_DIR))` before reading or writing files.

## Cross-Cutting Concerns

**Logging:** Console logging in `app/server.js`, append-only log files in `app/scripts/generate-plan.sh` and `skill/bin/run-daily-intel.sh`, and user-visible activity journaling in `activity.json`.

**Validation:** Route-level guards in `app/server.js` check required fields and allowed `:type` values; schedule validation lives in `skill/bin/install-schedule.sh`; no centralized schema validation layer is present.

**Authentication:** None detected. The dashboard is a local process intended for localhost use, and all trust boundaries are the local filesystem and local machine.

**Runtime-specific coupling:** Claude-only assumptions live in `install.sh`, `skill/SKILL.md`, `skill/bin/*.sh`, duplicated wrappers in `app/scripts/*.sh`, `/api/*` endpoints in `app/server.js` that invoke those wrappers, and UI instructions in `app/public/index.html` that tell users to run `~/.claude/job-quest/bin/install-schedule.sh`.

---

*Architecture analysis: 2026-04-21*
