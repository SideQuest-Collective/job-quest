# Workbook content format

Code reads these files. Follow this format exactly: a file that breaks a rule here is rejected and sent back.

## Files

- **Chapter file**: one chapter and its questions, in Markdown with `@@` directive lines.
- **Glossary file**: one `Term :: plain-English definition` per line. Lines that start with `#` are comments.

## Directive lines

Every block starts with a directive line at the very start of a line:

```
@@chapter id=<id> company=<company-slug or both> topic="<Topic>" title="<Title>"
@@q id=<id> company=<company-slug or both> topic="<Topic>" type=mcq|open|code diff=1|2|3 chapter=<chapter id>
```

- Attributes are `key=value` or `key="value with spaces"`. Never put a double quote inside a quoted value.
- Optional chapter attributes: `mins=<reading minutes>` and `sub="<one-line subtitle>"`.
- When you are given header lines, copy them exactly. Do not add, remove, reorder, or edit them.

## A chapter

After the `@@chapter` line, write the chapter in Markdown. It must contain these two headings, spelled exactly:

```
## In plain English
## Key takeaways
```

## A question

After the `@@q` line, write the prompt in Markdown. Then add sections, each marker on a line by itself:

| Section | mcq | open | code |
|---|---|---|---|
| `@@choices` | required | not used | not used |
| `@@hint` | optional | optional | optional |
| `@@rubric` | not used | required | required |
| `@@tests` | not used | not used | required |
| `@@answer` | required | required | required |

### @@choices (multiple choice)

- One option per line: `- [ ] text` or `- [x] text`.
- At least 3 options. Exactly one `[x]`.
- Balance the lengths: the longest option may be at most 1.8 times the median option length.

### @@rubric

A `-` list of plain-English checks a learner can tick off honestly, for example "- Explained why the first visit in BFS is the shortest path."

### @@tests (code questions)

A fenced JSON block. For a function:

```json
{"entry": "pair_sums", "cases": [{"args": [[1, 2, 3], 4], "expect": [[1, 3]]}, {"args": [[], 4], "expect": []}]}
```

For a class, `calls` is a list of `["method", [args], expected_return]`. Start with `["__init__", [constructor args], null]` when the constructor takes arguments:

```json
{"entry": "LRUCache", "calls": [["__init__", [2], null], ["put", [1, 1], null], ["get", [1], 1], ["get", [9], -1]]}
```

Rules:
- `args` and expected values are JSON. Tuples compare equal to lists, sets compare as sorted lists, and floats compare with a tiny tolerance.
- Every expected value is checked, including `null` (the method must return `None`).
- Use at least 3 cases, including an edge case: empty input, a tie, or a single element.
- Outputs must be deterministic: no randomness, no clock, no network, no files.

### @@answer

Start with the answer in one sentence, then explain why. For a code question, the reference solution is the longest fenced block marked `python` in `@@answer` that defines the entry (`def <entry>` or `class <entry>`). Code runs it against `@@tests` with Python 3, a 10-second limit, and no network.

## Markdown you may use

- `##`, `###`, `####` headings
- paragraphs
- `-` and `1.` lists; nest by indenting two spaces
- `**bold**`, `*italic*`, `` `code` ``
- fenced code blocks marked `python`, `js`, `sql`, or unmarked
- `>` blockquotes
- `|` tables with a `|---|` separator row
- `[text](https://...)` links

Hard rules:
- Never put a fenced code block inside a list item. Close the list, add the code block, then continue.
- Never use `|` inside a table cell, not even inside backticks. Write "or" instead.
- Use `*` for italics only when it wraps words tightly (`*like this*`). Write multiplication in backticks (`` `2 * 3` ``) or as `×`.
- Never write the text `</script` anywhere.

## Glossary file

```
Big-O notation :: A short way to say how running time grows with the input. O(n) doubles when the input doubles.
ADV :: Average daily volume: the typical number of shares of a stock traded in one day.
```

- Use the exact casing you use in the text.
- For acronyms, put the acronym first and the expansion in the definition.
- Terms are at least 2 characters; every definition is non-empty.
