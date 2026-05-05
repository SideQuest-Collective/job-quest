---
status: complete
completed: 2026-05-05
quick_id: 260505-jvv
slug: add-conversational-practice-for-prep-pla
---

# Summary

Implemented conversational system design practice for prep-plan prompts.

Changes:
- Added prep-plan-backed System Design topics from `role-tracker.json`.
- Routed Prep Plans and Intel system design prompt buttons to the matching System Design topic.
- Removed the inline static system design answer textbox from prep-plan cards.
- Added server test coverage for prep-plan topic discovery and conversation loading.

Verification:
- `npm test` in `app/` passed: 7 tests.
- `node --check app/server.js` passed.
- Live `http://localhost:3847/api/sd-topics` returns prep-plan topics from the installed data directory.
