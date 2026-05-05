---
status: complete
completed: 2026-05-05
quick_id: 260505-n1n
slug: remove-remaining-static-submit-review-fl
---

# Summary

Removed the remaining static submit-review path for prep-plan system design questions.

Changes:
- Prep-plan technical questions with `category: "system-design"` are now exposed as System Design mock interview topics.
- Intel and Prep Plans render those system design technical cards with `Practice as Conversation`, not textarea + `Submit for Review`.
- Reference answer reveal remains available.

Verification:
- `npm test` in `app/` passed: 7 tests.
- `node --check app/server.js` passed.
- Live `http://localhost:3847/api/sd-topics` includes generated technical system design prep-plan topics.
