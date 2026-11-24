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

## Local implementation workflow — October 8, 2026

For the authorized local UI, discovery, outreach, learning, feedback and private-access improvements, GSD is not required. Radhika explicitly removed that requirement for these changes. Maintain a written plan, reversible source control, private data backups and appropriate verification. No push, merge, release or deployment is authorized.




<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

## Routine phone interaction checks

For UI changes, check responsiveness alongside visual consistency on desktop and at 390px. Navigate through Dashboard, Discover, Intel and Practice, then revisit them; exercise menus, tabs, filters and the changed primary controls. Ready content should appear promptly without entrance animations or delayed tap feedback. Investigate any perceptible pause, especially delays around half a second or longer.

When navigation, shared state or polling changes, verify that hidden pages avoid unnecessary renders and requests, returning pages refresh current data, drafts survive navigation, and legitimate background jobs continue. Run the relevant lifecycle regression tests and repeat the affected flow against the installed local app. Restore viewport overrides and stop temporary preview servers afterward.

For phone performance reports, separate browser rendering, API response time and the private Tailscale connection. Check the actual phone through its existing private URL when available; otherwise state that real-device latency is unverified and request a refreshed-phone check after completing local verification. A desktop viewport or fast ping alone does not establish phone responsiveness. Do not change network exposure as part of these checks.
