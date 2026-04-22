# Codebase Structure

**Analysis Date:** 2026-04-21

## Directory Layout

```text
job-quest/
├── .planning/         # GSD project state and generated mapper outputs
├── app/               # Express server, static SPA, app-local helper scripts, docs
│   ├── public/        # Single-file frontend served by Express
│   ├── scripts/       # Claude CLI wrappers used by `app/server.js`
│   └── docs/          # Product/spec notes, not runtime code
├── skill/             # Claude skill definition, install-time scripts, prompt templates
│   ├── bin/           # Installed user-facing shell commands
│   └── references/    # Prompt template for scheduled intel generation
├── install.sh         # Repo bootstrap and install-layout creation
├── README.md          # Product-level install and usage guide
└── AGENTS.md          # Local agent instructions and GSD workflow rules
```

## Directory Purposes

**`.planning/`:**
- Purpose: Holds planning state and generated analysis artifacts for the GSD workflow.
- Contains: `PROJECT.md`, `STATE.md`, and mapper output files under `.planning/codebase/`.
- Key files: `.planning/PROJECT.md`, `.planning/STATE.md`

**`app/`:**
- Purpose: Contains the runnable local dashboard application.
- Contains: The Express server in `app/server.js`, package manifest in `app/package.json`, launcher in `app/start.sh`, one-page frontend in `app/public/index.html`, helper scripts in `app/scripts/`, and implementation notes in `app/docs/`.
- Key files: `app/server.js`, `app/public/index.html`, `app/package.json`, `app/start.sh`

**`app/public/`:**
- Purpose: Holds browser-delivered static assets.
- Contains: Only `app/public/index.html`, which includes CSS, React components, API helpers, and page logic in one file.
- Key files: `app/public/index.html`

**`app/scripts/`:**
- Purpose: Provide shell wrappers that the Express server calls for AI-backed features.
- Contains: `app/scripts/generate-plan.sh` and `app/scripts/code-review.sh`.
- Key files: `app/scripts/generate-plan.sh`, `app/scripts/code-review.sh`

**`app/docs/`:**
- Purpose: Store design notes and implementation planning related to app features.
- Contains: Markdown specs under `app/docs/superpowers/`.
- Key files: `app/docs/superpowers/specs/2026-04-07-intel-mission-control-design.md`, `app/docs/superpowers/plans/2026-04-07-intel-mission-control.md`

**`skill/`:**
- Purpose: Package the Claude-facing runtime integration that sits beside the app.
- Contains: The skill definition in `skill/SKILL.md`, installable shell commands in `skill/bin/`, and scheduled-agent prompt material in `skill/references/`.
- Key files: `skill/SKILL.md`, `skill/bin/run-daily-intel.sh`, `skill/bin/install-schedule.sh`, `skill/references/intel-agent-template.md`

**`skill/bin/`:**
- Purpose: Define the installed command surface exposed from `~/.claude/job-quest/bin/`.
- Contains: Start, schedule, uninstall, reinstall, daily intel, and Claude CLI wrapper scripts.
- Key files: `skill/bin/start.sh`, `skill/bin/run-daily-intel.sh`, `skill/bin/install-schedule.sh`, `skill/bin/uninstall.sh`, `skill/bin/reinstall.sh`, `skill/bin/generate-plan.sh`, `skill/bin/code-review.sh`

## Key File Locations

**Entry Points:**
- `install.sh`: Main installer and repo bootstrap for the installed layout under `~/.claude/job-quest/`
- `skill/SKILL.md`: Claude skill entrypoint for `/job-quest`
- `skill/bin/start.sh`: Installed dashboard launcher that injects `DATA_DIR`
- `skill/bin/run-daily-intel.sh`: Scheduled or manual daily intel generator
- `app/start.sh`: App-local launcher for development-style direct server starts
- `app/server.js`: Express runtime entrypoint

**Configuration:**
- `app/package.json`: App dependency manifest
- `app/.env`: Install-generated runtime config for `DATA_DIR` in the installed app layout
- `.planning/PROJECT.md`: Project goals and milestone framing
- `.planning/STATE.md`: Current planning state

**Core Logic:**
- `app/server.js`: All API routes, persistence helpers, schedule detection, and AI orchestration
- `app/public/index.html`: All frontend rendering and page-level interaction logic
- `app/scripts/generate-plan.sh`: Plan/evaluation/draft CLI bridge
- `app/scripts/code-review.sh`: Review/interview/edit CLI bridge

**Testing:**
- Not detected. No test directory, no `*.test.*` or `*.spec.*` files, and `app/package.json` only contains a placeholder `test` script.

## Naming Conventions

**Files:**
- Root scripts use lowercase kebab-case shell names such as `install.sh`, `start.sh`, `run-daily-intel.sh`, and `install-schedule.sh`.
- Main implementation files are flat and generic rather than feature-scoped, notably `app/server.js` and `app/public/index.html`.
- Planning outputs use uppercase markdown names under `.planning/codebase/`, such as `ARCHITECTURE.md` and `STRUCTURE.md`.

**Directories:**
- Runtime directories use short lowercase names: `app/`, `skill/`, `public/`, `scripts/`, `references/`, `docs/`.
- Installed data directories described by `install.sh` and `skill/SKILL.md` are feature-named lowercase directories such as `intel/`, `quizzes/`, `tasks/`, `problems/`, `behavioral/`, `conversations/`, `sd-conversations/`, and `resume-files/`.

## Where to Add New Code

**New dashboard feature:**
- Primary code: `app/server.js` for the API route and `app/public/index.html` for the UI, because the current codebase keeps both backend and frontend feature logic centralized there.
- Tests: Not established. If adding tests later, introduce a new test location under `app/` and avoid scattering it into the install-layer directories.

**New runtime-specific integration:**
- Claude-facing install or lifecycle behavior: `skill/bin/` and `skill/SKILL.md`
- App-internal CLI bridge used by server routes: `app/scripts/`
- Install-layout changes: `install.sh`

**New component or module:**
- Current implementation: No existing component/module directory. The codebase currently extends `app/public/index.html` for frontend sections and `app/server.js` for backend sections.
- Safer structural improvement path: If extracting code, keep backend modules under `app/` and frontend modules under `app/public/` to preserve the current top-level separation of app code vs skill/runtime code.

**Utilities:**
- Shared server helpers: place near the top of `app/server.js` if following the current style.
- Shared shell helpers: keep them in the relevant script file under `app/scripts/` or `skill/bin/` based on whether the caller is the server runtime or the installed CLI surface.

## Special Directories

**`app/public/`:**
- Purpose: Browser asset root served directly by Express.
- Generated: No
- Committed: Yes

**`skill/references/`:**
- Purpose: Prompt and schema reference material copied into the user data directory during install.
- Generated: No
- Committed: Yes

**`app/docs/`:**
- Purpose: Feature notes and design artifacts that explain app behavior but are not executed as part of the runtime.
- Generated: No
- Committed: Yes

**`.planning/codebase/`:**
- Purpose: Generated mapper documents used by other GSD commands.
- Generated: Yes
- Committed: Usually yes in this workflow

## Structural Notes

**Product/runtime split:**
- The cleanest top-level boundary is `app/` for the local product runtime and `skill/` for Claude-specific orchestration.
- That boundary is weakened by `app/scripts/`, because the server directly calls Claude-oriented shell wrappers instead of a runtime-neutral abstraction.

**Duplicated script surface:**
- `app/scripts/generate-plan.sh` and `skill/bin/generate-plan.sh` are parallel copies of the same adapter idea.
- `app/scripts/code-review.sh` and `skill/bin/code-review.sh` are also parallel copies.
- `skill/bin/start.sh` overlaps with `app/start.sh`, but adds install-root path assumptions and `DATA_DIR`.

**Ambiguous install vs source layout:**
- The repository source tree is split across `app/` and `skill/`.
- The installed layout documented in `README.md`, implemented by `install.sh`, and referenced by `skill/SKILL.md` collapses app code, scripts, references, and user data together under `~/.claude/job-quest/`.
- Any runtime-compatibility work needs to keep those two structures distinct: repo source paths live here, but end-user commands and data paths live in the installed root.

---

*Structure analysis: 2026-04-21*
