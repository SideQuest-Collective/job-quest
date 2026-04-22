<!-- GSD:project-start source:PROJECT.md -->
## Project

**Job Quest**

Job Quest is a local job-search command center with a web dashboard, scheduled daily intel generation, and a conversational skill entrypoint. Today it is built around Claude-specific install paths, skill registration, and CLI invocations; this project is to make that experience work in Codex as well without breaking the existing Claude flow.

**Core Value:** A job seeker can install Job Quest once and use the same core workflow from their chosen agent runtime without losing the local dashboard and automation that make the product useful.

### Constraints

- **Compatibility**: Claude behavior must keep working while Codex support is added — the current user base and docs assume Claude already works
- **Local-first**: Data stays on the user's machine in the install directory — the dashboard and scheduled jobs depend on local filesystem access
- **Brownfield**: Existing file layout, scripts, and dashboard endpoints must be evolved rather than replaced wholesale — lower migration risk
- **Scope**: This milestone should center on runtime compatibility, packaging, and verification — avoid unrelated product expansion
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
