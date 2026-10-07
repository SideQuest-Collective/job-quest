// app/tests/helpers/workbook-outlines.js
const q = (type, diff) => ({ type, diff, focus: `checks one ${type} skill` });

function screenOutline() {
  return { chapters: [
    { id: 'acme-context', title: 'Acme and the role', topic: 'Company', company: 'acme', kind: 'coding', summary: 'The reported Acme problem and its follow-ups.', questions: [q('mcq', 1), q('open', 1), q('code', 1), q('open', 2), q('code', 1)] },
    { id: 'arrays', title: 'Arrays and hashing', topic: 'Coding', company: 'both', kind: 'coding', summary: 'Hash maps for counting and lookup.', questions: [q('code', 2), q('code', 2), q('mcq', 1), q('open', 2), q('code', 1)] },
    { id: 'feed-design', title: 'Designing a feed', topic: 'System design', company: 'both', kind: 'system-design', summary: 'Fan-out on write versus read.', questions: [q('open', 3), q('mcq', 2), q('open', 2), q('mcq', 2), q('code', 2)] },
    { id: 'stories', title: 'Behavioral stories', topic: 'Behavioral', company: 'both', kind: 'behavioral', summary: 'STAR stories that fit this loop.', questions: [q('open', 1), q('open', 2), q('mcq', 1), q('code', 1), q('code', 1)] },
    { id: 'caching', title: 'Caching basics', topic: 'Fundamentals', company: 'both', kind: 'concepts', summary: 'Cache-aside, TTLs, and invalidation.', questions: [q('mcq', 2), q('code', 3), q('open', 2), q('mcq', 1), q('code', 2)] },
  ] };
}

function onsiteOutline() {
  return { chapters: [
    { id: 'onsite-loop', title: 'The onsite loop', topic: 'Company', company: 'acme', kind: 'coding', summary: 'Problems reported in the onsite.', questions: [q('mcq', 1), q('open', 2), q('code', 1), q('open', 1), q('code', 2), q('mcq', 2), q('open', 2)] },
    { id: 'concurrency', title: 'Concurrency in Python', topic: 'Coding', company: 'both', kind: 'coding', summary: 'Threads, locks, and queues.', questions: [q('code', 2), q('code', 3), q('mcq', 2), q('open', 2), q('mcq', 1), q('code', 2)] },
    { id: 'storage-design', title: 'Designing storage', topic: 'System design', company: 'both', kind: 'system-design', summary: 'Partitioning and replication.', questions: [q('open', 3), q('open', 2), q('code', 2), q('mcq', 1), q('code', 2), q('open', 3)] },
    { id: 'leadership', title: 'Leading without authority', topic: 'Behavioral', company: 'both', kind: 'behavioral', summary: 'Influence stories for staff-level loops.', questions: [q('open', 2), q('open', 1), q('mcq', 1), q('mcq', 2), q('open', 2), q('code', 1)] },
  ] };
}

module.exports = { screenOutline, onsiteOutline };
