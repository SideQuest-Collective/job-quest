# Phase 1: Runtime Audit and Abstraction Plan - Pattern Map

**Mapped:** 2026-04-22
**Phase:** 01 - Runtime Audit and Abstraction Plan

## Output Targets

| Planned Artifact | Role | Closest Existing Analog | Why This Analog Matters |
|------------------|------|-------------------------|-------------------------|
| `docs/runtime/runtime-coupling-audit.md` | Source-linked audit doc | `.planning/codebase/CONCERNS.md` and `.planning/codebase/ARCHITECTURE.md` | Both docs group evidence by issue, affected files, impact, and fix approach. |
| `docs/runtime/runtime-contract.md` | Design contract / ADR-style spec | `.planning/phases/01-runtime-audit-and-abstraction-plan/01-CONTEXT.md` | The phase context already models locked decisions and discretionary space clearly. |
| `docs/runtime/runtime-config-example.json` | Machine-readable config example | Existing JSON seeds in `install.sh` and runtime state files under `DATA_DIR` | The repo favors plain JSON with stable keys and pretty-print formatting. |
| `docs/runtime/runtime-migration.md` | Operator and follow-on implementation guide | `README.md`, `skill/SKILL.md`, `skill/bin/uninstall.sh`, `skill/bin/reinstall.sh` | These files define the current install and lifecycle behavior that the migration spec must replace safely. |

## Reusable Documentation Patterns

### Pattern: Evidence table with current behavior and impact
**Use for:** `runtime-coupling-audit.md`
**Analog source:** `.planning/codebase/CONCERNS.md`
**Reuse:**
- One row or bullet per finding
- Exact file paths
- Exact current assumption
- Impact on Codex support or Claude compatibility
- Follow-on phase ownership

### Pattern: Locked decision contract
**Use for:** `runtime-contract.md`
**Analog source:** `.planning/phases/01-runtime-audit-and-abstraction-plan/01-CONTEXT.md`
**Reuse:**
- Start from non-negotiable decisions
- Separate locked rules from implementer discretion
- Translate user decisions into config keys, path rules, and switching rules

### Pattern: Lifecycle step documentation
**Use for:** `runtime-migration.md`
**Analog source:** `README.md`, `skill/SKILL.md`, `skill/bin/uninstall.sh`, `skill/bin/reinstall.sh`
**Reuse:**
- Ordered flows for install, reinstall, uninstall, and schedule handling
- Explicit legacy behavior
- Clear "what persists" vs "what moves" statements

## Code and Constant Anchors

### Installer / lifecycle constants
- `install.sh`
  - `CLAUDE_DIR="$HOME_DIR/.claude"`
  - `SKILL_DIR="$CLAUDE_DIR/skills/job-quest"`
  - `APP_DIR="$CLAUDE_DIR/job-quest"`
  - `DATA_DIR="$APP_DIR"`
- `skill/bin/uninstall.sh`
  - same Claude-root constants
  - `LEGACY_APP_DIRS=("$HOME_DIR/job-quest" "$HOME_DIR/workspace/job-quest")`
- `skill/bin/reinstall.sh`
  - hard-coded reinstall through remote `install.sh`

**Why these matter:** The contract must replace these with neutral-home and runtime-registration concepts, not just different string literals.

### Runtime command resolution anchors
- `app/scripts/generate-plan.sh`
  - checks `command -v claude`
  - falls back to `npx -y @anthropic-ai/claude-code`
- `app/scripts/code-review.sh`
  - same runtime detection pattern
- `skill/bin/generate-plan.sh` and `skill/bin/code-review.sh`
  - duplicated copies of the same wrapper logic
- `skill/bin/run-daily-intel.sh`
  - same runtime discovery, but with a broader allowed-tools contract

**Why these matter:** The future runtime adapter should collapse these repeated checks into one shared command-resolution source.

### Scheduler and server anchors
- `skill/bin/install-schedule.sh`
  - `DATA_DIR="$HOME/.claude/job-quest"`
  - `RUNNER="$DATA_DIR/bin/run-daily-intel.sh"`
  - `PLIST_LABEL="com.sidequest.job-quest.daily-intel"`
- `app/server.js`
  - `path.join(__dirname, 'scripts', 'generate-plan.sh')`
  - `path.join(__dirname, 'scripts', 'code-review.sh')`
  - `claude_prompt_` temp filenames
  - launchd plist detection logic

**Why these matter:** Any runtime contract that ignores scheduler labels, runner paths, or server-side helper selection will be incomplete.

### UI and docs anchors
- `README.md`
  - user-facing `~/.claude/job-quest/...` install and command examples
- `skill/SKILL.md`
  - onboarding writes directly into `~/.claude/job-quest/...`
  - repeated `/job-quest` and Claude-specific workflow text
- `app/public/index.html`
  - hard-coded schedule command `~/.claude/job-quest/bin/install-schedule.sh "3 7 * * 1-5"`
  - repeated `Claude`, `Claude CLI`, and Claude-only failure copy

**Why these matter:** Runtime support is not only a shell concern; user-facing copy also needs a shared runtime-aware source.

## Recommended Plan-to-File Mapping

### Plan 01-01: Runtime audit
- Primary output: `docs/runtime/runtime-coupling-audit.md`
- Required evidence inputs:
  - `install.sh`
  - `README.md`
  - `skill/SKILL.md`
  - `skill/bin/start.sh`
  - `skill/bin/install-schedule.sh`
  - `skill/bin/run-daily-intel.sh`
  - `skill/bin/generate-plan.sh`
  - `skill/bin/code-review.sh`
  - `skill/bin/uninstall.sh`
  - `skill/bin/reinstall.sh`
  - `app/scripts/generate-plan.sh`
  - `app/scripts/code-review.sh`
  - `app/server.js`
  - `app/public/index.html`

### Plan 01-02: Runtime contract and migration
- Primary outputs:
  - `docs/runtime/runtime-contract.md`
  - `docs/runtime/runtime-config-example.json`
  - `docs/runtime/runtime-migration.md`
- Required design inputs:
  - `docs/runtime/runtime-coupling-audit.md`
  - `.planning/phases/01-runtime-audit-and-abstraction-plan/01-CONTEXT.md`
  - `.planning/phases/01-runtime-audit-and-abstraction-plan/01-RESEARCH.md`
  - `install.sh`
  - `skill/bin/start.sh`
  - `skill/bin/install-schedule.sh`
  - `skill/bin/run-daily-intel.sh`
  - `skill/bin/uninstall.sh`
  - `skill/bin/reinstall.sh`
  - `app/server.js`

## Constraints the Executor Should Respect

- Do not invent a second product home per runtime; Phase 1 decisions require one shared installation/state footprint.
- Do not document API-based runtime integration; Phase 1 is CLI-only by decision.
- Do not hide migration behavior behind vague wording like "handle legacy installs"; spell out the legacy path and the expected switch semantics.
- Keep artifact language product-neutral except where runtime-native entrypoints or runtime-native directories must be named explicitly.
