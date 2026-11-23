# Workbook style guide: explain, don't assume

## Who is reading

{{name}}: {{currentRole}}, about {{yearsExperience}} years of experience, preparing for the {{role}} role at {{company}} (target level: {{targetLevel}}). They study on their own, often offline, in short sessions.

Strengths:
{{strengths}}

Interview weak spots:
{{weakSpots}}

Assume nothing beyond the strengths above. Anything outside them is defined in plain words the first time it appears.

## The plain-English standard

The reader has said short, dense notes are "concise but incomprehensible". Write so that someone who has never met a term understands it from the page alone:

- **Never use a term before defining it**, even common interview jargon: "non-goal", "idempotent", "lease", "in-degree", "p99", "fan-out", "backoff", "embedding". Define it in the same sentence, in everyday words, with an example.
- **Full sentences, not notes.** No arrow chains ("A -> B -> C") as explanations, no fragments like "Non-goal: exactly-once; fake it." Write: "We are deliberately not promising exactly-once. That would mean a job can never run twice, which is very hard across crashes. Instead..."
- **Show the arithmetic** for every number, step by step.
- **Prefer tables with a "what it means in plain words" column** when listing requirements, fields, or options.
- **Order topics the way they come up in the interview day**: the skills the earliest round needs come first.

## The job

Write content that **teaches**. The goal is understanding, not a cheat sheet. Keep every fact tied to the research; don't invent facts about the company. You may add general, well-established technical explanation.

Teach how to answer the interview questions, not what the company does. Don't write about the company's products, business, history, or news, and never ask a question whose answer is a fact about the company. A reported scenario can be the setting for a problem; the question tests the code or the design.

## Chapters

Structure each chapter like this:

1. **`## In plain English`**
   - 2–4 sentences: what this topic is, and why an interviewer asks about it.
   - No jargon in this section at all.
2. **Build concepts in order**, simplest first. For each concept:
   - **Define every term the first time it appears**, in plain words, right there in the sentence. Example: "an *idempotency key* (a unique ID the client attaches to a request so the server can recognise a retry of the same request)".
   - Spell out acronyms and say what they mean. If a term needs more than a sentence, give it its own short paragraph.
   - **Give a concrete example** with real-looking values: a tiny input, a trace, a before and after.
     - Algorithms: trace them step by step on a small input, e.g. "queue: [A] → pop A, push B, C → queue: [B, C] …".
     - Numbers: show the arithmetic.
   - **Say why it matters**: what goes wrong without it, or what the interviewer is checking.
3. **Big-O notation.**
   - The first time it appears in a chapter, say what the letters mean. Example: "O(V + E), where V is the number of nodes and E the number of edges: we touch each node and each edge a constant number of times".
   - Don't just state the complexity; say *why* it is that.
4. **Code.**
   - Before the code: one or two sentences on the idea.
   - After the code: a numbered walk-through of the important lines, plus a trace on a tiny input showing the state as it runs.
5. **Tables** compare things *after* those things have been explained in prose. A table is never the only explanation of a concept. Keep cells short.
6. **System design chapters follow a fixed structure** (code rejects the chapter otherwise). Use exactly these `##` headings, in this order, after `## In plain English`:
   - `## The problem in plain words`: what we are building and for whom, in everyday words. Define the main nouns (for example "a *job* is one piece of work").
   - `## Functional requirements`: what the system must *do*. A table with columns: Requirement, What it means in plain words, Example. Open with one sentence defining "functional requirement".
   - `## Non-functional requirements`: how *well* it must do it (scale, latency, durability, availability, consistency, fairness, cost, observability). A table: Quality, What it means in plain words, Target to say out loud, Why it matters. Open with one sentence defining "non-functional requirement".
   - `## Out of scope`: what we deliberately do not build, each with the reason. Open by defining it: "Out of scope (also called a non-goal) means something we say out loud we are not building, so the interviewer knows we chose to leave it out."
   - `## Size estimate`: back-of-envelope numbers as numbered steps with the arithmetic, then one sentence on what the numbers tell you (for example "one database is enough").
   - `## Core entities`: the main things stored. For each, a table of fields with their plain meaning. Show any status lifecycle.
   - `## API`: a table of calls and what each does.
   - `## High-level design`: a ```diagram block of the main boxes and arrows, then a `-` list explaining what each box does.
   - `## Step by step`: the life of one request or job through the boxes, as a numbered list.
   - `## Deep dives`: each hard part as its own `###` with the problem, the solution, a worked example, and what goes wrong without it.
   - `## Questions they will ask`: likely follow-ups, each as **Q:** and **A:** in plain words.
7. **Algorithm chapters prepare for unseen variants, not only the reported question.** After teaching the reported problem, add `## Related questions` with 3 to 6 neighbouring questions in the same style (a changed rule, a bigger input, a costly or noisy operation, a probability twist), each with a short plain answer and its cost. When the chapter covers several patterns, include a table mapping the wording of a question ("top k", "depends on", "fewest steps") to the pattern to use.
8. **`## How this comes up in the interview`**
   - What they're likely to ask.
   - Example phrasings of a good answer, marked as something to say out loud.
9. **`## Key takeaways`**: 3–6 bullets in plain sentences.

Writing style:
- Short sentences. Active voice. Talk to the reader as "you".
- Prefer "the fastest way", "the list", "the lookup table" over clever or insider phrasing.
- When there is a common mistake, show the mistake and the fix.
- Clarity beats brevity, but don't pad. Every sentence should teach something.

## Questions

Every question must make sense on its own, without the chapter open.

### The prompt

- Set up the scenario fully.
- Define any term the question depends on.
- Say exactly what's being asked. No trick wording or insider shorthand.
- For **written** questions, add one line saying what a complete answer covers, without giving the answer away. Example: "A full answer covers what happens, why, and how you'd fix it."
- For **code** questions, give the function signature, what the input looks like with a small example input and the expected output, and any rules about ties or edge cases.

### Multiple-choice options

- Plainly worded and plausible.
- One clearly correct option.
- Similar in length, so the longest one isn't always the answer.

### The answer key (`@@answer`)

- Start with the answer in one sentence.
- Then explain **why**, step by step, showing the arithmetic or the trace.
- For multiple choice, add a short line for **each wrong option** explaining why it's wrong.
- For code, give a short idea summary, the reference solution, then a walk-through and a traced example.

### Rubric (`@@rubric`)

- Plain-English checklist items a learner can tick off honestly.

### Hints (`@@hint`)

- Add one to every code question and every written question with difficulty 2 or 3.
- A hint nudges ("Think about what you'd need to remember per book") without giving the solution.

## Glossary

List every term a learner might not know that appears in your chapter, in the glossary file you are told to write, one `Term :: definition` per line. Aim for complete coverage.
