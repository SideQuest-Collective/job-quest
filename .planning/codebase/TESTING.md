# Testing Patterns

**Analysis Date:** 2026-04-21

## Test Framework

**Runner:**
- Not detected.
- `app/package.json` defines `npm test` as a placeholder that exits with an error instead of running tests.
- Config: Not applicable. No `jest.config.*`, `vitest.config.*`, `playwright.config.*`, or similar file exists.

**Assertion Library:**
- Not applicable. No automated JavaScript test library is present.

**Run Commands:**
```bash
cd app && npm test          # Placeholder only; prints "Error: no test specified" and exits 1
cd app && ./start.sh        # Manual app smoke run
bash install.sh             # Manual installer verification
~/.claude/job-quest/bin/install-schedule.sh --show   # Manual schedule verification after install
```

## Test File Organization

**Location:**
- No test files are present under the repository outside `app/node_modules/`.
- There is no `__tests__/` tree and no `*.test.*` or `*.spec.*` source file in the project.

**Naming:**
- Not applicable for repo tests.
- User data and runtime outputs are stored as dated JSON under the install root, for example `intel/2026-04-21.json`, `tasks/2026-04-21.json`, and `quizzes/2026-04-21.json`.

**Structure:**
```text
No automated test directory structure is present.
```

## Test Structure

**Suite Organization:**
```text
No automated test suites are implemented.
```

**Patterns:**
- Validation is mostly manual and runtime-driven:
  - Start the server with `app/start.sh` or `node app/server.js`
  - Exercise endpoints through the browser UI in `app/public/index.html`
  - Verify generated files under `DATA_DIR` after installer or daily-intel runs
- The closest thing to executable assertions is the Code Lab feature in `app/server.js`, where `/api/run-code` executes user Python against `testCases` supplied by problem JSON.
- AI-driven features validate output opportunistically by attempting `JSON.parse(...)` and falling back through multiple extraction strategies in `app/server.js`.

## Mocking

**Framework:** Not used

**Patterns:**
```text
There is no repo-level mocking framework.
```

**What to Mock:**
- Current code does not mock external tools. It calls the real filesystem, `python3`, `tectonic`, `claude`, `npx`, `launchctl`, and `crontab` directly from `app/server.js`, `install.sh`, and `skill/bin/*.sh`.
- If automated tests are introduced, the first seams to mock should be:
  - filesystem reads/writes around `DATA_DIR` in `app/server.js`
  - child-process execution for Claude CLI, Python, Tectonic, cron, and launchd
  - time/date for streak and daily-file logic

**What NOT to Mock:**
- Current manual verification assumes real local filesystem behavior and real installed tools.
- For installer and schedule flows, a useful smoke test should exercise actual path creation and script wiring, not only mocked calls.

## Fixtures and Factories

**Test Data:**
```javascript
// Current pattern is seeded JSON defaults written directly by install scripts.
[ -f "$DATA_DIR/role-actions.json" ] || echo '{"saved":[],"skipped":[],"applied":[]}' > "$DATA_DIR/role-actions.json"
[ -f "$DATA_DIR/progress.json" ] || echo '{}' > "$DATA_DIR/progress.json"
```

**Location:**
- Seed data is created in `install.sh`.
- Runtime schemas are implied by `app/server.js`.
- AI-generated content schemas are described in `skill/references/intel-agent-template.md`.
- There are no dedicated fixture or factory directories.

## Coverage

**Requirements:** None enforced

**View Coverage:**
```bash
# Not available; no coverage tooling is configured
```

## Test Types

**Unit Tests:**
- Not used.
- Helper functions in `app/server.js` such as `readDataDir`, `calculateStreak`, `detectSchedule`, and `cronToHuman` are untested.

**Integration Tests:**
- Not used.
- Real integrations are exercised manually through:
  - `install.sh`
  - `skill/bin/install-schedule.sh`
  - `skill/bin/run-daily-intel.sh`
  - API endpoints in `app/server.js`

**E2E Tests:**
- Not used.
- The nearest equivalent is manual browser verification against `http://localhost:3847` after starting `app/server.js`.

## Current Validation Surfaces

**Application smoke testing:**
- `app/start.sh` and `skill/bin/start.sh` are the primary entrypoints for local verification.
- `app/public/index.html` polls `/api/*` endpoints every 30 seconds, so loading the dashboard acts as a broad smoke test for many routes.

**Installer validation:**
- `install.sh` verifies `node` and `git`, clones the repo, installs `app/` dependencies, seeds directories, and copies scripts.
- `skill/bin/uninstall.sh` and `skill/bin/reinstall.sh` provide the current manual regression path for lifecycle testing.

**Schedule validation:**
- `skill/bin/install-schedule.sh --show` reports whether launchd or crontab entries exist.
- `app/server.js` also inspects schedule state via `detectSchedule()` and exposes it through `/api/job-status`.

**AI output validation:**
- `app/server.js` validates AI responses by parsing JSON directly, then trying fenced JSON extraction, then brace matching for:
  - `/api/interview-plan`
  - `/api/evaluate-answer`
  - `/api/behavioral/generate-draft`
- `skill/bin/generate-plan.sh` and `skill/bin/run-daily-intel.sh` log stdout/stderr and preserve partial output for debugging.

**Code execution validation:**
- `/api/run-code` in `app/server.js` dynamically writes a Python file, runs `python3`, and returns structured pass/fail results for each case.
- This is a product feature, not a repository test suite, because cases come from user/problem data rather than from committed tests.

## Common Patterns

**Async Testing:**
```javascript
// Current code validates async/CLI work through callback completion and JSON parsing.
exec(`bash "${scriptPath}" "${tmpPrompt}"`, { timeout: 300000 }, (err, stdout, stderr) => {
  if (err) {
    res.json({ error: true, message: 'Plan generation failed' });
    return;
  }
  let plan = null;
  try { plan = JSON.parse((stdout || '').trim()); } catch {}
  res.json({ plan });
});
```

**Error Testing:**
```javascript
// Current style returns fallback JSON rather than failing hard.
if (!key) return res.status(400).json({ error: 'key required' });

if (err) {
  res.json({
    response: 'Claude CLI is not available. Install it with `npm install -g @anthropic-ai/claude-code` or check your PATH.',
    error: true,
  });
}
```

## Gaps To Preserve In Planning

- Do not claim a test suite exists. The repo currently relies on manual verification and runtime smoke checks.
- Any future feature work in `app/server.js` should include at least a manual verification note covering:
  - affected route
  - seed/default file behavior under `DATA_DIR`
  - missing-tool behavior for external CLIs
- The highest-value first automated tests would target:
  - JSON file CRUD endpoints in `app/server.js`
  - schedule detection and cron-to-human formatting in `app/server.js`
  - installer/uninstaller flows in `install.sh` and `skill/bin/uninstall.sh`
  - Python code-runner behavior for success, assertion failure, and exception cases

---

*Testing analysis: 2026-04-21*
