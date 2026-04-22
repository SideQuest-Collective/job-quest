# Coding Conventions

**Analysis Date:** 2026-04-21

## Naming Patterns

**Files:**
- Use lowercase filenames with simple extensions and no build step: `app/server.js`, `app/public/index.html`, `install.sh`, `skill/bin/run-daily-intel.sh`.
- Shell helpers use hyphenated verb phrases: `skill/bin/install-schedule.sh`, `skill/bin/code-review.sh`, `skill/bin/generate-plan.sh`.
- Data directories and persisted JSON files use lowercase names and date-based filenames: `intel/2026-04-21.json`, `tasks/2026-04-21.json`, `problems/progress.json`.

**Functions:**
- Use `camelCase` for JavaScript helpers and component-local utilities in `app/server.js` and `app/public/index.html`: `readDataDir`, `logActivity`, `autoCompleteDailyTask`, `calculateStreak`, `handleZipUpload`.
- Use `PascalCase` for React components embedded in `app/public/index.html`: `App`, `Dashboard`, `Resume`, `CodeLab`, `Behavioral`.
- Shell scripts use lowercase helper names with underscores only when shell ergonomics make it clearer: `log`, `is_macos`, `generate_plist`, `write_crontab` in `skill/bin/install-schedule.sh`.

**Variables:**
- Use `camelCase` for mutable locals and request/body fields in JavaScript: `todayTasks`, `roleTracker`, `saveTimerRef`, `questionIndex`.
- Use `UPPER_SNAKE_CASE` for process-wide constants and directory paths: `DATA_DIR`, `ACTIVITY_FILE`, `PROFILE`, `LOG_FILE`, `RESUME_DIR`.
- Use short uppercase names for shell path constants and booleans: `APP_DIR`, `SKILL_DIR`, `KEEP_DATA`, `AUTO_YES`.

**Types:**
- No TypeScript or JSDoc type aliases are present.
- Data “types” are implicit JSON object shapes described by route code in `app/server.js` and prompt/schema text in `skill/references/intel-agent-template.md`.

## Code Style

**Formatting:**
- No formatter config is present. There is no `.prettierrc`, `eslint.config.*`, or `biome.json` in the repo root.
- Follow the existing 2-space indentation in JavaScript, HTML, CSS, and shell files such as `app/server.js`, `app/public/index.html`, and `install.sh`.
- Prefer single quotes in JavaScript unless template literals are needed for prompts or command strings.
- Keep route handlers and React components inline in their current host files instead of splitting into many modules unless the refactor is intentional and broad.
- Persist JSON with pretty printing via `JSON.stringify(value, null, 2)` as used throughout `app/server.js`.

**Linting:**
- No lint tool is configured.
- Consistency is enforced manually by matching neighboring code, not by a ruleset.

## Import Organization

**Order:**
1. Node built-ins via `require(...)`: `fs`, `path`, `os`, `crypto`, `child_process` in `app/server.js`
2. Third-party packages: `express`, `adm-zip` in `app/server.js`
3. Local constants, helpers, and route declarations in the same file

**Path Aliases:**
- No path aliases are used.
- Use relative paths or `path.join(__dirname, ...)` in JavaScript and explicit filesystem paths in shell scripts.

## Error Handling

**Patterns:**
- Prefer fail-soft reads for local JSON stores: return `[]`, `{}`, or seeded objects when files are missing in `app/server.js`.
- Use inline `try { ... } catch {}` for cleanup and best-effort parsing when failure should not block the request, for example temp-file cleanup and JSON fallback parsing in `app/server.js`.
- Return JSON error payloads from API endpoints instead of throwing uncaught exceptions: `res.status(400).json({ error: 'key required' })`, `res.status(422).json({ error: 'Compilation failed', output: ... })`.
- Shell scripts use `set -e` or `set -euo pipefail` to fail early, then print human-readable diagnostics before exiting, as in `install.sh`, `skill/bin/generate-plan.sh`, and `skill/bin/install-schedule.sh`.
- AI/CLI integrations usually degrade to a usable response instead of hard failing, for example `/api/code-review` returns an explanatory message if Claude CLI is unavailable in `app/server.js`.

## Logging

**Framework:** `console` in `app/server.js`; file-backed shell logging in `skill/bin/*.sh` and `app/scripts/*.sh`

**Patterns:**
- Use bracketed request IDs for long-running AI calls in `app/server.js`: `plan_*`, `eval_*`, `beh_*`.
- Append timestamped lines to log files in shell scripts with a small `log()` helper, for example `skill/bin/generate-plan.sh` and `skill/bin/run-daily-intel.sh`.
- Record user-visible activity to JSON via `logActivity(...)` in `app/server.js` whenever state changes.

## Comments

**When to Comment:**
- Use section banners to group behavior in large files: `// --- API Routes ---`, `/* ===== DASHBOARD ===== */`.
- Add short intent comments ahead of non-obvious shell or filesystem operations, such as preserving data in `skill/bin/uninstall.sh` or explaining launchd behavior in `skill/bin/install-schedule.sh`.
- Keep comments sparse inside straightforward CRUD handlers.

**JSDoc/TSDoc:**
- Not used in `app/server.js` or `app/public/index.html`.

## Function Design

**Size:** Large functions are common.
- `app/server.js` is a monolithic 1437-line Express server with many route handlers and embedded prompt strings.
- `app/public/index.html` is a monolithic 4108-line static page with inline CSS and React components.
- New code should match local style when editing these files, but avoid making handlers or components longer if a local helper can reduce repetition without changing structure.

**Parameters:**
- Route handlers destructure `req.body` near the top: `const { code, functionName, testCases } = req.body;`.
- Helpers usually accept narrow primitives or callbacks: `readDataDir(subdir)`, `autoCompleteDailyTask(matchFn)`.
- Shell scripts parse flags from positional arguments with `case` statements rather than external parsers.

**Return Values:**
- Express endpoints return JSON directly and often use success sentinels such as `{ success: true }`.
- Helper functions return plain objects/arrays rather than classes.
- Shell scripts write primary results to stdout and operational traces to logs or stderr.

## Module Design

**Exports:**
- There are effectively no reusable JS modules in the app code.
- `app/server.js` is the executable backend entrypoint.
- `app/public/index.html` embeds the entire frontend in one `text/babel` script tag.

**Barrel Files:**
- Not used.

## Shell Script Conventions

- Use `#!/bin/bash` headers everywhere: `install.sh`, `app/start.sh`, `skill/bin/*.sh`.
- Favor explicit path setup via `$HOME`, `$(dirname "$0")`, and named directory constants.
- Prefer small helper functions for repeated logging and platform checks rather than sourcing shared libraries.
- Keep user messaging plain and imperative. Install/uninstall scripts print next steps directly instead of returning machine-readable output.
- Duplicate logic exists intentionally between `skill/bin/*.sh` and `app/scripts/*.sh`; when touching one, check the paired script.

## Data Handling

- Treat the filesystem as the database. `app/server.js` reads and writes JSON synchronously under `DATA_DIR`.
- Use date strings in `YYYY-MM-DD` format for daily records and streak logic.
- Preserve compatibility with existing install paths rooted at `~/.claude/job-quest` as used by `install.sh`, `skill/SKILL.md`, and `skill/bin/*.sh`.
- When adding persisted data, follow the existing pattern: ensure the parent directory exists, seed defaults when absent, and write prettified JSON.

## Example Patterns

**Backend helper pattern from `app/server.js`:**
```javascript
function readDataDir(subdir) {
  const dir = path.join(DATA_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}
```

**Frontend fetch wrapper pattern from `app/public/index.html`:**
```javascript
const api = {
  get: (url) => fetch(url).then(r => r.json()),
  post: (url, data) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json()),
};
```

**Shell logging pattern from `skill/bin/generate-plan.sh`:**
```bash
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}
```

## Practical Guidance

- When editing backend behavior, stay in `app/server.js` unless the change clearly warrants a new helper file and you are prepared to introduce the first real module boundary.
- When editing the frontend, preserve the current inline React+Babel approach in `app/public/index.html` and follow existing hook/state patterns instead of introducing a bundler.
- When editing installer/runtime scripts, preserve bash compatibility and the existing `~/.claude/job-quest` path assumptions unless the task is explicitly about runtime abstraction.
- When adding validation, prefer explicit JSON error responses and log enough context to debug failed CLI invocations or filesystem operations.

---

*Convention analysis: 2026-04-21*
