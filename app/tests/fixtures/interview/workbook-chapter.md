@@chapter id=coding-basics company=acme-capital topic="Coding" title="Coding basics"
## In plain English

A sweep line turns intervals into start and end events, sorted by time.

## Key takeaways

- Sort the events, walk a running count, keep the maximum.

@@q id=c1 company=acme-capital topic="Coding" type=code diff=2 chapter=coding-basics
Return the peak number of overlapping intervals.
@@rubric
Sweep line over +1 and -1 events; ends before starts on ties.
@@tests
```json
{"entry": "peak", "cases": [{"args": [[[1, 3], [2, 4]]], "expect": 2}, {"args": [[]], "expect": 0}]}
```
@@answer
Make a +1 event at each start and a -1 event at each end, sort, and keep a running maximum.

```python
def peak(intervals):
    events = sorted([(s, 1) for s, _ in intervals] + [(e, -1) for _, e in intervals])
    current = best = 0
    for _, delta in events:
        current += delta
        best = max(best, current)
    return best
```

@@q id=s1 company=acme-capital topic="System design" type=open diff=3 chapter=coding-basics
Design a per-user rate limiter for a public API.
@@rubric
Token bucket per user; refill rate versus burst size; shared store; fixed-window boundary trap.
@@answer
Use a token bucket per user in a shared store such as Redis; the refill rate is the steady limit and the bucket size is the burst.

@@q id=b1 company=acme-capital topic="Behavioral" type=open diff=1 chapter=coding-basics
Tell me about a time you disagreed with a teammate.
@@rubric
Situation, task, action, result; owns their part; shows the outcome.
@@answer
Name the disagreement, what you each wanted, how you tested both options, and the result.
