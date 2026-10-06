# Interview transcript 2026-03-14_0930

_Saved on stop. Round: coding._

_14:30:00: capture started_

**Interviewer** (14:30:20): Welcome. We will work through two small platform coding exercises.

_14:31:00: question: Rate limiter: sliding window_

**Interviewer** (14:31:10): Accept at most three requests in any ten-second window. Requests arrive in timestamp order.

**You** (14:42:00): The queue contains only accepted requests inside the active window.

_14:50:00: question: Merge overlapping intervals_

**Interviewer** (14:50:10): Given a list of closed intervals, return their merged ranges, including intervals that touch.

**You** (15:01:00): I will sort by start time and extend the last interval when the ranges overlap.

**Interviewer** (15:14:00): Thanks. Both approaches are clear; add a nested-interval example to your tests.

_15:15:00: capture stopped_
