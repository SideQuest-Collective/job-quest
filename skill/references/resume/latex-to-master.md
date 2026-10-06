# LaTeX resume converter

Convert one LaTeX resume into Job Quest's master resume JSON. A person reviews your output as a diff before anything is saved, so copy facts exactly and invent nothing.

## LaTeX source
<<<TEX
{{tex}}
TEX>>>

## Rules
1. Copy text exactly, minus LaTeX markup: `\&` becomes `&`, `\%` becomes `%`, `\$` becomes `$`; drop commands such as `\textbf`, `\small`, `\vspace`, `\hfill`.
2. Dates are `YYYY-MM`: "Mar 2019" becomes "2019-03". "Present" or "Current" becomes `null` for an `end`. Education dates may be "", "YYYY", or "YYYY-MM".
3. One `experience` entry per employer, newest first; its roles newest first.
4. IDs: employers are lowercase slugs of the employer name ("acme-corp"); roles are short lowercase slugs unique across the resume ("acme-senior"); projects are "proj." plus a slug ("proj.pantry"). Do not give bullets an `id`; the program assigns them.
5. Keep the resume's skill groups and items. Split items on commas, but keep a parenthesized list together: "AWS (Lambda, S3)" is one item.
6. Leave a field as "" (or [] for a list) when the resume does not have it. Never guess.

## Output
Reply with only this JSON object inside a ```json code fence, and write nothing after the fence:

```json
{
  "version": 1,
  "contact": { "name": "", "email": "", "phone": "", "linkedin": "", "location": "", "links": [] },
  "headline": "",
  "summary": "",
  "experience": [ { "id": "acme-corp", "employer": "Acme Corp", "start": "2019-03", "end": null,
    "roles": [ { "id": "acme-senior", "title": "Senior Engineer", "team": "", "start": "2022-01", "end": null,
      "bullets": [ { "text": "..." } ] } ] } ],
  "projects": [ { "id": "proj.pantry", "name": "", "tech": [], "bullets": [ { "text": "..." } ] } ],
  "skills": [ { "group": "Languages", "items": ["Python"] } ],
  "education": [ { "school": "", "degree": "", "start": "", "end": "" } ],
  "certifications": []
}
```
