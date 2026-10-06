# Debrief 2026-03-14_0930

Round: coding

## Phase timings

| Phase | Spent | Budget | Status |
|---|---|---|---|
| Clarify | 3:00 | 3:00 | ok |
| Things to try next | 2:00 | 2:00 | ok |
| Solution | 5:00 | 5:00 | ok |
| Optimizations | 5:00 | 5:00 | ok |
| Code | 20:00 | 15:00 | over |
| Test | 10:00 | 5:00 | over |

Total session: 45:00. Interviewer utterances: 40. Your utterances: 60. Clipboard captures: 4. Hints given: 2.

## Scorecard

Interviewer: Alex, platform team. Problem: implement a sliding-window request limiter, then merge overlapping intervals. Outcome: working solutions with boundary cases discussed.

### Phase discipline
- Clarification stayed within three minutes by writing down the input assumptions.
- Coding used twenty minutes; interval examples caught an endpoint comparison issue.
- Reserved the final five minutes for complexity and memory trade-offs.

### Requirements and clarification
- Good: confirmed sorted request timestamps and the limit for each window.
- Clarify whether touching intervals should merge before writing the comparison.

### Unanswered or weakly answered follow-ups
- Explain how the request queue changes when a timestamp lies exactly on the window boundary.

### Strengths
1. Stated the limiter invariant: "The queue contains only accepted requests inside the active window."
2. Explained the interval plan: "I will sort by start time and extend the last interval when the ranges overlap."
3. Walked through empty input and a single interval before running examples.

### Tighten
1. Write the endpoint rule next to the merge condition.
2. Compare queue and ring-buffer memory costs explicitly.
3. Include nested intervals in the first test batch.

### Prepare for the next round
1. Practice merging touching and nested intervals.
2. Implement a limiter with requests from multiple clients.
3. State time and space complexity before the final walkthrough.
