---
status: in-progress
created: 2026-05-05
quick_id: 260505-na0
slug: fix-ask-ai-assistant-pane-persistence-an
---

# Quick Task: Fix Ask AI Assistant Pane

Goal: Keep Code Lab Ask AI sessions alive when switching dashboard tabs and make the assistant pane's input/messages use the resized bottom panel space.

Plan:
1. Persist Code Lab assistant state directly into the lifted session ref during in-flight Ask AI requests.
2. Restore pending assistant state on remount, including loading status.
3. Change the bottom assistant panel to a flex layout so dragging it taller expands the message area.
4. Replace the one-line assistant input with a larger multiline textarea that supports Shift+Enter for newlines.
5. Run server syntax/tests and leave the refreshed dashboard running.
