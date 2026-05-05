---
status: complete
completed: 2026-05-05
quick_id: 260505-na0
slug: fix-ask-ai-assistant-pane-persistence-an
---

# Summary

Fixed Code Lab Ask AI assistant persistence and panel layout.

Changes:
- Persisted in-flight Ask AI updates directly into the lifted Code Lab session ref.
- Restored `chatLoading` and chat state when returning to Code Lab after navigation.
- Reworked the bottom assistant panel as a flex layout so dragging it taller expands the useful message area.
- Replaced the one-line assistant input with a larger resizable textarea.

Verification:
- `npm test` in `app/` passed: 7 tests.
- `node --check app/server.js` passed.
