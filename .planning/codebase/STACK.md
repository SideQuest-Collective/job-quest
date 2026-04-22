# Technology Stack

**Analysis Date:** 2026-04-21

## Languages

**Primary:**
- JavaScript - Server-side CommonJS in `app/server.js`, shell-invoked Node entrypoints in `app/start.sh` and `skill/bin/start.sh`, and browser-side JSX/JavaScript embedded in `app/public/index.html`

**Secondary:**
- Bash - Installer, runtime wrappers, scheduling, reinstall, and uninstall flows in `install.sh` and `skill/bin/*.sh`
- Python 3 - Local subprocess execution for Code Lab in `app/server.js` and JSON/profile parsing plus `launchd` plist generation in `skill/bin/run-daily-intel.sh` and `skill/bin/install-schedule.sh`
- JSON - Package metadata in `app/package.json`, lockfile data in `app/package-lock.json`, and the app's local persistence format under `DATA_DIR`

## Runtime

**Environment:**
- Node.js 18+ - Required by `install.sh` and documented in `README.md` and `app/README.md`
- Browser runtime - The dashboard is a static SPA served from `app/public/index.html`
- POSIX shell environment - Required by `install.sh` and `skill/bin/*.sh`

**Package Manager:**
- npm - Used in `install.sh` (`cd "$APP_DIR/app" && npm install --silent`)
- Lockfile: present in `app/package-lock.json`

## Frameworks

**Core:**
- Express 5.2.1 - Local API server and static file host in `app/server.js`, pinned via `app/package.json` and `app/package-lock.json`
- React 18.2.0 UMD - Browser UI loaded from CDN in `app/public/index.html`
- ReactDOM 18.2.0 UMD - Browser rendering runtime loaded from CDN in `app/public/index.html`

**Testing:**
- Not detected - `app/package.json` only defines the placeholder `npm test` script and no test framework config is present under the repo root or `app/`

**Build/Dev:**
- No bundler or transpile step detected - `app/public/index.html` loads `babel-standalone` 7.23.9 in the browser instead of using a repo build pipeline
- Marked 11.1.1 - Markdown rendering in `app/public/index.html`
- PDF.js 3.11.174 - Resume PDF preview in `app/public/index.html`
- Ace Editor 1.32.7 - In-browser code editing in `app/public/index.html`

## Key Dependencies

**Critical:**
- `express` 5.2.1 - Core HTTP server for all dashboard APIs in `app/server.js`
- `adm-zip` 0.5.17 - ZIP extraction for resume bundle uploads in `app/server.js`
- `@anthropic-ai/claude-code` via `npx -y` fallback - AI-backed generation/review runtime used by `app/scripts/generate-plan.sh`, `app/scripts/code-review.sh`, and `skill/bin/run-daily-intel.sh`

**Infrastructure:**
- `python3` executable - Required for `POST /api/run-code` in `app/server.js`; also used by scheduling and profile helper scripts in `skill/bin/run-daily-intel.sh` and `skill/bin/install-schedule.sh`
- `tectonic` executable - Optional local LaTeX-to-PDF compiler for resume features in `app/server.js` and documented in `README.md`
- `git`, `curl`, and `npm` executables - Install/update toolchain in `install.sh` and `skill/bin/reinstall.sh`
- `launchd` or `crontab` - Local scheduler backend managed by `skill/bin/install-schedule.sh`

## Configuration

**Environment:**
- `DATA_DIR` - Main runtime storage root, read in `app/server.js` and written by `install.sh` into `app/.env`
- `PORT` - Optional HTTP port override, read in `app/server.js` and surfaced by `skill/bin/start.sh`
- `HOME`, `PATH`, `NVM_DIR` - Used by `install.sh`, `app/scripts/*.sh`, and `skill/bin/*.sh` to resolve installs and CLI executables
- `.env` file present at `app/.env` - Used for local app configuration; installer-managed path config only, not a documented secret store

**Build:**
- No `tsconfig.json`, bundler config, Dockerfile, or frontend build config detected at repo root or under `app/`
- Package metadata lives in `app/package.json`
- Dependency resolution is locked in `app/package-lock.json`

## Platform Requirements

**Development:**
- macOS or Linux shell environment - Scheduling logic in `skill/bin/install-schedule.sh` branches between `launchd` and `crontab`
- Node.js 18+
- npm
- git
- Optional local tools: `python3`, `tectonic`, `claude` CLI or `npx`

**Production:**
- Local workstation deployment - The app is designed to run from `~/.claude/job-quest/` after `install.sh`
- Local HTTP dashboard - `app/server.js` serves on `http://localhost:3847` by default
- Local filesystem persistence - User state is stored under `DATA_DIR` rather than a hosted database

---

*Stack analysis: 2026-04-21*
