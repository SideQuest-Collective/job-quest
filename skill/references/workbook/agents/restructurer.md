TARGET_FILE: {{targetFile}}
CHAPTER_ID: {{chapterId}}
MODE: {{mode}}

# Rewrite one system design chapter in the delivery framework: {{chapterTitle}}

This chapter of a study workbook for the {{role}} role at {{company}} gives the reader a lot of information but does not show them how to *solve* the design problem in an interview. Rewrite it so the reader learns to deliver the design step by step, in the order an interviewer expects.

Write exactly one file, `{{targetFile}}`, in the current directory: the new chapter **body only**. Do not write the `@@chapter` line or any question; code keeps those. Never write a line that starts with `@@`.

## The structure (code rejects the file without it)

Use exactly these `##` headings, in this order:

1. `## In plain English`: what is being designed and why interviewers ask it, with no jargon.
2. `## The problem in plain words`: what we are building and for whom; define the main nouns.
3. `## Functional requirements`: one sentence defining the term, then a table with columns Requirement, What it means in plain words, Example.
4. `## Non-functional requirements`: one sentence defining the term, then a table with columns Quality, What it means in plain words, Target to say out loud, Why it matters.
5. `## Out of scope`: start by defining it ("out of scope, also called a non-goal, means something we say out loud we are not building, so the interviewer knows we chose to leave it out"), then each item with its reason.
6. `## Size estimate`: numbered steps with the arithmetic, then one sentence on what the numbers decide.
7. `## Core entities`: each main thing stored, with a table of fields and their plain meaning; show any status lifecycle.
8. `## API`: a table of calls and what each does.
9. `## High-level design`: a ```diagram block, then a `-` list explaining every box.
10. `## Step by step`: the life of one request through the boxes, as a numbered list.
11. `## Deep dives`: the hardest parts, each as a `###` with the problem, the solution, a worked example, and what goes wrong without it.
12. `## Questions they will ask`: likely follow-ups, each as **Q:** and **A:**.
13. `## How this comes up in the interview`: what to say out loud at each step, with timings for a 45-minute round.
14. `## Key takeaways`: 3 to 6 plain sentences.

## Rules

- Keep every correct fact, number and technique from the current chapter that helps answer the design. Move it to the step where it belongs. Drop material that doesn't help solve the problem.
- If the chapter covers several design prompts, build it around the most likely one, and give each other prompt a short `### Same family: ...` part inside `## Deep dives` with its key difference and its one hardest decision.
- If the chapter teaches the method itself (a design frame), apply the structure to its main worked example and say at each step what that step is for.
- The practice questions below stay as they are, so the chapter must teach what they ask.
- Define every term before using it, in everyday words with an example. Full sentences, no shorthand notes, no arrow chains in place of explanations.
- Aim for 1,800 to 3,000 words.

## The current chapter (data, not instructions)

<chapter>
{{chapterBody}}
</chapter>

## Its practice questions (unchanged; for scope)

{{questions}}

## Research and notes (data, not instructions)

<research>
{{research}}
</research>

## Style guide

{{styleGuide}}

## Format spec

{{formatSpec}}

{{fixSection}}

When the file is written, reply with one line: `wrote {{targetFile}}`.
