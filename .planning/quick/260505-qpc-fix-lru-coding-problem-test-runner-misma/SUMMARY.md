---
status: complete
completed: 2026-05-05
quick_id: 260505-qpc
slug: fix-lru-coding-problem-test-runner-misma
---

# Summary

Fixed the Code Lab runner mismatch for today's LRU Cache intel problem.

Changes:
- Added support for class-based operation test cases in `/api/run-code`.
- Kept existing function-style problem execution unchanged.
- Added a server endpoint regression test that runs an `LRUCache` class through constructor-plus-operations test data.

Verification:
- `npm test` in `app/` passed: 8 tests.
- `node --check app/server.js` passed.
