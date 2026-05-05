---
status: in-progress
created: 2026-05-05
quick_id: 260505-qpc
slug: fix-lru-coding-problem-test-runner-misma
---

# Fix LRU Coding Problem Test Runner Mismatch

## Goal
Make the Code Lab runner handle today's `lru-cache` problem shape, where the starter code defines an `LRUCache` class and test cases describe constructor arguments plus ordered method operations.

## Plan
1. Update `/api/run-code`'s Python harness so class callables with an `operations` array are instantiated once, then each operation is dispatched to the instance and collected as the test result.
2. Preserve the existing function-style behavior for normal coding problems.
3. Add a server endpoint test that posts an `LRUCache` class implementation and verifies operation-style tests pass.
4. Run the app test suite.
