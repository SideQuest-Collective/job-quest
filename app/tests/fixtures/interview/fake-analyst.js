// app/tests/fixtures/interview/fake-analyst.js
// Scripted "debrief-analyst" agent for the fake runtime, matching the shared fixture session.
module.exports = async ({ cwd, fs, path, attempt, prompt }) => {
  fs.writeFileSync(path.join(cwd, `prompt-${attempt}.txt`), prompt);
  fs.writeFileSync(path.join(cwd, 'analysis.json'), JSON.stringify({
    asked: [
      {
        title: 'Rate limiter: sliding window',
        prompt: 'Accept at most three requests in any ten-second window, given requests in timestamp order.',
        type: 'code', topic: 'Coding', diff: 2,
        rubric: 'Evicts timestamps at or before the window cutoff, checks the queue length, and appends only accepted requests.',
        answer: 'Keep accepted timestamps in a queue; remove expired entries before accepting a request when fewer than three remain.',
        grade: 'got', evidence: 'Explained the active-window invariant and tested the boundary timestamp.',
      },
      {
        title: 'Merge overlapping intervals',
        prompt: 'Given closed intervals, return the merged ranges, treating intervals with a shared endpoint as overlapping.',
        type: 'open', topic: 'Coding', diff: 3,
        rubric: 'Clarifies endpoint handling, sorts by start time, and extends the last range to the maximum end.',
        answer: 'Sort intervals by start; append disjoint intervals and merge overlapping or touching ones into the final output range.',
        grade: 'partial', evidence: 'Needed a reminder to include touching and nested interval cases.',
      },
    ],
    weakSpots: [{ label: 'Clarify whether touching intervals should merge', ref: 1 }],
    followUps: [
      { text: 'Practice merging touching and nested intervals' },
      { text: 'Confirm the next round with the recruiter', due: '2026-10-09' },
    ],
  }));
};
