# Codebase Concerns

**Analysis Date:** 2026-04-21

## Confirmed Concerns

## Tech Debt

**[Confirmed] Claude-specific runtime coupling is embedded across install, skill, scripts, server responses, and UI copy:**
- Issue: The project assumes `~/.claude/...`, Claude skill registration, and Claude CLI availability as the product contract instead of isolating runtime-specific behavior behind an abstraction.
- Files: `install.sh`, `README.md`, `skill/SKILL.md`, `skill/bin/run-daily-intel.sh`, `skill/bin/start.sh`, `skill/bin/generate-plan.sh`, `skill/bin/code-review.sh`, `app/server.js`, `app/public/index.html`
- Impact: Codex support requires touching many unrelated layers at once, which increases regression risk for the existing Claude flow and makes dual-runtime support harder to verify.
- Fix approach: Introduce a runtime/config layer for install paths, skill registration targets, and CLI invocation; replace hard-coded user-facing strings and command hints with runtime-aware values sourced from one module or config file.

**[Confirmed] Install artifacts and user data share the same root directory:**
- Issue: `install.sh` sets `APP_DIR="$HOME/.claude/job-quest"` and `DATA_DIR="$APP_DIR"`, so repo files, scripts, logs, generated data, and user-authored resume assets all live in one tree.
- Files: `install.sh`, `skill/bin/uninstall.sh`, `skill/bin/reinstall.sh`, `skill/bin/start.sh`, `skill/bin/run-daily-intel.sh`
- Impact: Reinstall/uninstall logic is inherently destructive and harder to reason about because application code and persistent state are not isolated.
- Fix approach: Split immutable install assets from mutable user data, then make scripts operate on those two roots explicitly.

**[Confirmed] Helper scripts are duplicated in two locations with no enforcement that they stay in sync:**
- Issue: The active install copies `skill/bin/*.sh` into `~/.claude/job-quest/bin/`, while near-identical copies also exist under `app/scripts/`.
- Files: `skill/bin/generate-plan.sh`, `skill/bin/code-review.sh`, `app/scripts/generate-plan.sh`, `app/scripts/code-review.sh`, `install.sh`
- Impact: Runtime behavior can drift depending on which copy is invoked, and compatibility fixes must be applied twice.
- Fix approach: Keep one canonical script implementation and have the app and installer reference that single source.

**[Confirmed] Core backend and frontend are large monoliths:**
- Issue: The main server is a 1,437-line single file and the dashboard UI is a 4,108-line single HTML file with embedded app logic.
- Files: `app/server.js`, `app/public/index.html`
- Impact: Small compatibility changes are likely to create unrelated regressions, and targeted testing is difficult because concerns are not isolated by module.
- Fix approach: Extract route groups, filesystem helpers, AI/runtime adapters, and major UI surfaces into smaller modules before expanding compatibility work.

## Known Bugs

**[Confirmed] Dashboard greeting is hard-coded to a developer name:**
- Symptoms: The home screen renders `Tarun` regardless of the active user profile.
- Files: `app/public/index.html`
- Trigger: Opening the dashboard home view.
- Workaround: None in-product; requires editing the frontend code.

**[Confirmed] `activity.json` seed shape does not match server expectations:**
- Symptoms: Installer seeds `activity.json` as `[]`, but `readActivity()` and `logActivity()` treat it as an object keyed by date.
- Files: `install.sh`, `skill/SKILL.md`, `app/server.js`
- Trigger: First write to activity after a fresh install.
- Workaround: The first write mutates the array object into an object-like structure in JavaScript, but the file starts in an invalid/ambiguous shape.

**[Confirmed] Behavioral answers file has conflicting shapes between seed docs and API behavior:**
- Symptoms: Onboarding/install docs seed `behavioral/answers.json` as `[]`, while the API reads and writes it as an object map keyed by question.
- Files: `install.sh`, `skill/SKILL.md`, `app/server.js`
- Trigger: First behavioral answer save after following the documented seed flow.
- Workaround: The API overwrites the file with an object on first write, but the stored shape is inconsistent across code paths.

## Security Considerations

**[Confirmed] Multiple write endpoints accept arbitrary filenames without path-boundary enforcement:**
- Risk: Attackers with local access to the HTTP server can write outside the intended data subdirectory by passing traversal paths such as `../...`.
- Files: `app/server.js`
- Current mitigation: Partial path checks exist only on some resume read/save/delete routes.
- Recommendations: Add `path.resolve(...).startsWith(expectedRoot)` checks before every filesystem write, especially `/api/data/:type`, `/api/resume/upload`, `/api/resume/upload-zip`, `/api/resume/upload-folder`, and `/api/resume/compile`.

**[Confirmed] `/api/data/:type` can escape its target directory via `filename`:**
- Risk: `writeData(type, filename, data)` uses `path.join(dir, filename)` without sanitizing `filename`.
- Files: `app/server.js`
- Current mitigation: `type` is restricted to `intel`, `quizzes`, or `tasks`, but `filename` is unrestricted.
- Recommendations: Restrict filenames to a safe basename pattern like `YYYY-MM-DD.json` and reject separators or `..`.

**[Confirmed] Resume upload routes allow path traversal writes:**
- Risk: `/api/resume/upload`, `/api/resume/upload-zip`, and `/api/resume/upload-folder` write user-controlled filenames and relative paths without verifying that the resolved destination stays inside `RESUME_DIR`.
- Files: `app/server.js`
- Current mitigation: Allowed file extensions and hidden-directory skips reduce some abuse but do not block `../` paths.
- Recommendations: Normalize each candidate path, reject absolute/traversal segments, and verify the final resolved path stays under `RESUME_DIR`.

**[Confirmed] Code execution endpoint runs arbitrary Python on the host without sandboxing:**
- Risk: `/api/run-code` writes user code into a temp file and runs `python3` directly under the dashboard process account.
- Files: `app/server.js`
- Current mitigation: A 10-second timeout and 1 MB buffer cap.
- Recommendations: Move execution into a real sandbox or isolated worker with CPU, memory, filesystem, and network restrictions.

**[Confirmed] AI helper routes shell out to local CLIs with full user privileges:**
- Risk: `/api/interview-plan`, `/api/evaluate-answer`, `/api/behavioral/generate-draft`, `/api/code-review`, `/api/sd-conversation/:topicId`, `/api/resume/edit`, and the daily scheduler all invoke shell scripts or agent CLIs directly.
- Files: `app/server.js`, `app/scripts/generate-plan.sh`, `app/scripts/code-review.sh`, `skill/bin/generate-plan.sh`, `skill/bin/code-review.sh`, `skill/bin/run-daily-intel.sh`
- Current mitigation: Basic timeouts and some tool restrictions in `generate-plan.sh`.
- Recommendations: Centralize command execution, validate inputs, remove unnecessary shell interpolation, and separate runtime adapters from HTTP routes.

**[Confirmed] Daily intel grants the agent broad local capabilities instead of constraining writes to Job Quest data files:**
- Risk: `run-daily-intel.sh` allows `Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash`, which gives the agent broad access to the local environment under the user account.
- Files: `skill/bin/run-daily-intel.sh`
- Current mitigation: Prompt instructions ask the agent to stay within `~/.claude/job-quest`, but that boundary is advisory.
- Recommendations: Remove `Bash` unless strictly necessary, reduce allowed tools, and drive file output through a narrower trusted wrapper.

**[Confirmed] The dashboard assumes localhost trust and has no authentication or authorization layer:**
- Risk: Any local process that can reach the port can hit write and execution endpoints.
- Files: `app/server.js`, `skill/bin/start.sh`
- Current mitigation: The server binds to the local machine by default and does not advertise remote hosting.
- Recommendations: Add an optional local auth token/session gate before exposing destructive or execution-capable endpoints.

## Performance Bottlenecks

**[Confirmed] The app repeatedly rereads whole JSON datasets synchronously on request paths:**
- Problem: Many routes call `fs.readFileSync`, `fs.writeFileSync`, and `readDataDir()` for every request, reloading entire directories and files.
- Files: `app/server.js`
- Cause: The data layer is synchronous and file-based with no caching or write serialization.
- Improvement path: Add a small storage layer with schema validation, atomic writes, and cached reads for hot paths.

**[Confirmed] Every AI feature spawns a fresh CLI process and reparses free-form output:**
- Problem: Interview prep, evaluation, code review, behavioral drafting, resume editing, and system-design chat all launch external commands with large prompt payloads.
- Files: `app/server.js`, `app/scripts/generate-plan.sh`, `app/scripts/code-review.sh`
- Cause: Runtime integration is process-per-request and depends on brittle post-processing of stdout.
- Improvement path: Introduce a runtime adapter with structured responses, reusable invocation logic, and better failure handling.

## Fragile Areas

**[Confirmed] JSON parsing and extraction logic is duplicated and brittle:**
- Files: `app/server.js`
- Why fragile: Multiple routes attempt direct parse, code-fence extraction, then brace counting on model output. The approach can break on malformed or nested output and is copied across several handlers.
- Safe modification: Replace ad hoc parsing with a shared response parser and schema validation per route.
- Test coverage: None detected for any parser path.

**[Confirmed] Install/update/uninstall flows depend on destructive filesystem operations in a mixed code+data directory:**
- Files: `install.sh`, `skill/bin/uninstall.sh`, `skill/bin/reinstall.sh`
- Why fragile: `git pull`, tar-based overlay, `rm -rf`, temp staging, and curl-to-bash reinstall all operate on the same tree that holds user content.
- Safe modification: Separate app/data roots first, then add dry-run and backup-aware path guards.
- Test coverage: None detected for install lifecycle scripts.

**[Confirmed] Scheduling logic is OS-specific and only partially abstracted:**
- Files: `skill/bin/install-schedule.sh`, `app/server.js`, `app/public/index.html`
- Why fragile: The installer uses launchd on macOS and cron elsewhere, while detection and UI copy duplicate schedule assumptions and runtime paths.
- Safe modification: Keep a single schedule metadata source and make the UI render runtime/config data instead of hard-coded commands.
- Test coverage: None detected for schedule install/detect/remove flows.

**[Confirmed] The frontend embeds Claude-specific naming and path hints directly in the UI:**
- Files: `app/public/index.html`
- Why fragile: The UI contains `Claude` labels, Claude-only failure messages, and hard-coded `~/.claude/job-quest/bin/install-schedule.sh` instructions, so compatibility changes require editing the monolithic UI file rather than config.
- Safe modification: Extract runtime strings into configuration delivered by the server.
- Test coverage: None detected for runtime-specific UI states.

## Scaling Limits

**[Confirmed] Data model scales only as far as synchronous local JSON files remain cheap to scan:**
- Current capacity: Practical for a single local user with modest daily history.
- Limit: As `intel/`, `tasks/`, `quizzes/`, `conversations/`, and `resume-files/` grow, request latency and corruption risk increase because the app rescans directories and rewrites whole files.
- Scaling path: Add a storage abstraction with atomic writes, file locking or queuing, and paginated reads.

## Dependencies at Risk

**[Confirmed] Runtime integration depends on the Anthropic CLI package and command names:**
- Risk: Core features fail if `claude` or `npx -y @anthropic-ai/claude-code` is unavailable or changes behavior.
- Impact: Interview prep, code review, system-design chat, behavioral drafting, resume editing, and scheduled intel generation stop working.
- Migration plan: Replace direct CLI assumptions with a runtime adapter that can target Claude and Codex backends interchangeably.

**[Confirmed] Install/reinstall depends on live GitHub network fetches and remote script execution:**
- Risk: `install.sh` clones from GitHub and `reinstall.sh` pipes the remote `install.sh` directly into `bash`.
- Impact: Reinstall reliability depends on network reachability and remote branch state; rollback and reproducibility are poor.
- Migration plan: Pin install sources by version/commit and prefer local script reuse over remote `curl | bash`.

## Missing Critical Features

**[Confirmed] Automated test coverage for installer, scheduler, and runtime adapters is missing:**
- Problem: `app/package.json` defines `"test": "echo \"Error: no test specified\" && exit 1"` and no test files or test config were detected.
- Blocks: Safe refactoring of Claude-specific assumptions into Codex-compatible abstractions.

**[Confirmed] Input validation and schema enforcement are missing on write-heavy APIs:**
- Problem: Most POST routes trust `req.body` shape and persist raw JSON directly.
- Blocks: Reliable multi-runtime integrations and safer local execution.

## Test Coverage Gaps

**[Confirmed] No automated tests detected for the Express API or filesystem behavior:**
- What's not tested: Route handlers, JSON parsing fallbacks, filesystem persistence, schedule detection, and resume workflows.
- Files: `app/server.js`, `app/package.json`
- Risk: Refactors for Codex compatibility can silently break existing Claude behavior.
- Priority: High

**[Confirmed] No automated tests detected for install lifecycle scripts:**
- What's not tested: Fresh install, upgrade into an existing data directory, uninstall, reinstall with `--keep-data`, and schedule cleanup.
- Files: `install.sh`, `skill/bin/uninstall.sh`, `skill/bin/reinstall.sh`, `skill/bin/install-schedule.sh`
- Risk: The most destructive code paths have no regression net.
- Priority: High

## Plausible But Unverified Risks

## Security Considerations

**[Plausible] `tectonic` compilation may broaden the local attack surface beyond intended resume editing:**
- Risk: The resume compile flow runs a native compiler on uploaded LaTeX content, but the exact security posture depends on `tectonic` defaults and the user environment.
- Files: `app/server.js`
- Current mitigation: Only the resume-file tree is intended to be compiled, and execution is time-limited.
- Recommendations: Treat compilation as untrusted content processing and move it into an isolated worker or sandbox.

## Performance Bottlenecks

**[Plausible] Large uploaded resume archives or many historical artifacts may degrade dashboard responsiveness noticeably:**
- Problem: ZIP extraction, recursive file walking, and repeated directory scans are synchronous and run in-process.
- Files: `app/server.js`
- Cause: CPU and filesystem work happen on the main Node event loop.
- Improvement path: Cap upload sizes, offload expensive work, and avoid repeated full-tree scans in request handlers.

## Fragile Areas

**[Plausible] Concurrent scheduled writes and interactive dashboard edits may corrupt or overwrite JSON state:**
- Files: `skill/bin/run-daily-intel.sh`, `app/server.js`
- Why fragile: Scheduled jobs and HTTP requests write the same JSON files with no locking, temp-file swap, or transaction semantics.
- Safe modification: Add atomic write helpers and serialized access per file family.
- Test coverage: None detected for concurrent access behavior.

**[Plausible] `git pull` into a live mixed code/data directory may fail or leave partially updated installs when local state collides with repo content:**
- Files: `install.sh`
- Why fragile: The installer updates the install root in place and overlays repo contents onto a directory that also stores user files.
- Safe modification: Perform upgrades in a separate versioned app directory, then switch a pointer/symlink after validation.
- Test coverage: None detected for upgrade edge cases.

---

*Concerns audit: 2026-04-21*
