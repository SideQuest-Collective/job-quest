# Runtime Coupling Audit

## Audit Scope

This audit inventories the current Claude-coupled surfaces that later compatibility phases must revisit. Every finding in this document maps back to a committed repo file so follow-on changes can stay source-linked and reviewable.

## Runtime Coupling Inventory

| Layer | File | Claude-specific assumption | Why it blocks Codex | Target follow-on phase |
| --- | --- | --- | --- | --- |
| Install | `install.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Docs | `README.md` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Skill | `skill/SKILL.md` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Runtime launcher | `skill/bin/start.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Scheduler | `skill/bin/install-schedule.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Scheduled runtime | `skill/bin/run-daily-intel.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Wrapper | `skill/bin/generate-plan.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Wrapper | `skill/bin/code-review.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Lifecycle | `skill/bin/uninstall.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Lifecycle | `skill/bin/reinstall.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| App wrapper | `app/scripts/generate-plan.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| App wrapper | `app/scripts/code-review.sh` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| Server | `app/server.js` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |
| UI | `app/public/index.html` | Pending population in Task 2. | Pending population in Task 2. | Pending population in Task 3. |

## Duplicate Wrapper Surface

Pending population in Task 2.

## Follow-on Phase Impact

Pending population in Task 3.

## Verification Checklist

Pending population in Task 3.
