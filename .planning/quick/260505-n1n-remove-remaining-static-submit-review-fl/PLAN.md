---
status: in-progress
created: 2026-05-05
quick_id: 260505-n1n
slug: remove-remaining-static-submit-review-fl
---

# Quick Task: Remove Static System Design Review Flow

Goal: Ensure prep-plan system design questions are practiced only through the conversational System Design tab, including generated technical questions categorized as `system-design`.

Plan:
1. Expose `technicalQuestions` with `category: "system-design"` as prep-plan System Design topics.
2. Change both prep-plan render paths so those cards show `Practice as Conversation` instead of textarea + `Submit for Review`.
3. Keep reference answer reveal available for users who want to review notes.
4. Verify with server tests and syntax checks.
