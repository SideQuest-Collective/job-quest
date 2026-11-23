---
name: job-quest
description: Your personal job hunt command center — AI-powered daily intel, interview prep, coding practice, and role tracking. Use this skill when the user wants to organize their job search, get daily job recommendations, practice interviews, track applications, or mentions wanting help finding their next role. Triggers on "job quest", "get a job", "job hunting", "interview prep", "job search setup", or any request about structuring a job search. Even if the user just casually mentions looking for a new role, this skill can help.
---

<objective>
Set up and run a personalized job hunt command center. This is a conversational onboarding experience — you're the user's job search coach. Walk them through setup, learn about their background, configure their daily intel agent, and get them started with their first prep session.
</objective>

<execution_context>
@$HOME/.job-quest/references/intel-agent-template.md
</execution_context>

<startup_update>
Before onboarding, return-flow routing, or installation management, attempt a non-destructive update check:

```bash
~/.job-quest/bin/update.sh --if-needed
```

Rules:
- If the script reports that Job Quest updated successfully, tell the user briefly that the local install was refreshed from remote and continue.
- If it reports that Job Quest is already up to date, continue without making a big deal of it.
- If the update check fails because the network is unavailable or the install has local repo changes, tell the user briefly and continue with the current install instead of stopping the whole session.
- If `~/.job-quest/bin/update.sh` is missing, continue normally; the user is likely on an older install and the next manual reinstall/update will add it.
</startup_update>

<startup_schedule>
After the update check, make sure a daily intel schedule exists:

```bash
~/.job-quest/bin/install-schedule.sh --exists
```

Rules:
- If a schedule exists, continue normally.
- If no schedule exists, install the default schedule immediately:

```bash
~/.job-quest/bin/install-schedule.sh "3 7 * * 1-5"
```

- Tell the user briefly that Job Quest restored the default weekday 7:03 AM schedule because none was installed.
- If schedule installation fails, tell the user briefly and continue; do not block the rest of the skill flow on schedule setup.
</startup_schedule>

<first_run_detection>
First, check the user's raw input for an **installation management keyword**. If their message contains (case-insensitive) any of: `uninstall`, `reinstall`, `reset`, `nuke my install`, `start over`, `wipe everything`, route immediately to the "Installation Management" section below — do not run onboarding, do not show the menu. This lets users type `/job-quest reinstall` and skip straight to the action.

If their message contains (case-insensitive) any schedule-management keywords such as `schedule`, `reschedule`, `change time`, `update schedule`, `weekdays`, `daily`, or `cron`, route to the "Schedule Management" section below after the update/schedule startup checks.

Otherwise, check if `~/.job-quest/data/profile.json` exists.
- If it does NOT exist → this is a first run. Start the full onboarding flow below.
- If it DOES exist → the user is returning. Read their profile and ask what they want to do today (review intel, prep for an interview, practice coding, check progress, manage installation, etc).
</first_run_detection>

## First Run: Onboarding Flow

This is a conversation, not a script. Be warm, encouraging, and adapt to the user's energy. Someone who just got laid off needs different vibes than someone casually browsing. Read the room.

### Phase 1: Get to Know Them

Start with something like: "Let's get your job quest set up. First, tell me a bit about yourself — what do you do now and what are you looking for next?"

Then have a natural conversation to gather:

**Essential (get these before moving on):**
- Their name
- Current or most recent role and level
- Years of experience
- Core technical strengths (what they're genuinely good at)
- Target role level (Senior, Staff, Principal, etc.)
- Target companies or company types
- Location preferences (remote, hybrid, specific cities)
- What matters most to them in their next role

**Pick up naturally if it comes up:**
- Preferred industries
- Deal-breakers
- Interview weak spots
- Timeline and urgency

**How to interview:**
- Extract anything already mentioned in their first message — don't re-ask what they already told you
- Use AskUserQuestion for structured choices (target level, company categories, schedule preferences)
- Follow up conversationally for nuanced stuff (strengths, values, deal-breakers)
- If they give short answers, work with what you have
- Summarize and confirm: "Here's what I'm hearing — does this sound right?"

Once confirmed, save to `~/.job-quest/data/profile.json`:
```json
{
  "name": "...",
  "currentRole": "...",
  "yearsExperience": 6,
  "strengths": ["distributed systems", "API design", "data pipelines"],
  "targetLevel": "Staff",
  "targetCompanies": {
    "specific": ["Google", "Stripe"],
    "categories": ["FAANG", "AI Labs", "High-growth"]
  },
  "locationPrefs": "Remote, USA",
  "values": ["technical challenge", "positive impact"],
  "industries": ["AI/ML", "developer tools"],
  "dealBreakers": ["no crypto"],
  "interviewWeakSpots": ["system design at Staff level"],
  "timeline": "actively searching"
}
```

### Phase 2: Initialize the Data Directory

Create the full directory structure at `~/.job-quest/data/`:

```bash
mkdir -p ~/.job-quest/data/{intel,quizzes,tasks,problems,behavioral,conversations,sd-conversations,resume-files,logs}
```

Seed empty JSON files so nothing crashes on first read. The shipped `install.sh` copies `app/skill/seed/problems.json` (30 base problems across 4 categories) into `~/.job-quest/data/problems/problems.json` for new installs; if you're seeding manually outside the installer, mirror that:
```bash
cp ~/.job-quest/app/skill/seed/problems.json ~/.job-quest/data/problems/problems.json
echo '{"solved":{},"bookmarked":[],"savedCode":{}}' > ~/.job-quest/data/problems/progress.json
echo '{}' > ~/.job-quest/data/behavioral/answers.json
echo '{}' > ~/.job-quest/data/role-tracker.json
echo '{"saved":[],"skipped":[],"applied":[]}' > ~/.job-quest/data/role-actions.json
echo '{}' > ~/.job-quest/data/activity.json
echo '{}' > ~/.job-quest/data/progress.json
echo '{}' > ~/.job-quest/data/resume.json
```

### Phase 3: Set Up the Dashboard App

Check if Node.js 18+ is installed (`node --version`). If not, walk the user through installing it for their platform.

Everything Job Quest needs lives under the shared home at `~/.job-quest/`, with the repo checkout in `app/` and mutable user data in `data/`. Clone and install the dashboard there:
```bash
git clone https://github.com/SideQuest-Collective/job-quest.git ~/.job-quest/app
cd ~/.job-quest/app/app && npm install
```

The installer writes the dashboard data directory explicitly:
```bash
echo "DATA_DIR=~/.job-quest/data" > ~/.job-quest/app/app/.env
```

If the user already ran `install.sh`, this is done. Skip re-cloning — just confirm the layout.

### Phase 3b: Import Their Resume

Resume tailoring builds every tailored resume from one master resume, so get it now. Never assume where the resume lives; every user keeps it somewhere different.

1. Ask: "Where's your current resume on this computer? A file or a folder is fine. PDF, Word, Markdown, plain text and LaTeX all work." Accept a path, a dragged-in file, or "I don't know". Expand `~` and handle spaces in paths.
2. If they don't know, offer to look (ask first): `find ~/Documents ~/Desktop ~/Downloads -maxdepth 4 -type f \( -iname '*resume*' -o -iname '*cv*' \) \( -iname '*.pdf' -o -iname '*.docx' -o -iname '*.doc' -o -iname '*.md' -o -iname '*.txt' -o -iname '*.tex' \) 2>/dev/null | head -40`. Show the matches with modification dates and let them pick. Never read a file they didn't pick.
3. If they point at a folder with several versions, pick the default resume: prefer one with no company name in its file name, then the most recently modified. Confirm the choice with them. Company-specific versions are history, not the master.
4. Turn the chosen resume into the master:
   - **`content.py` + `resume_cv.tex` workflow:** `node ~/.job-quest/app/skill/bin/import-resume.js --content <content.py> --tex <resume_cv.tex>`.
   - **Anything else (PDF, Word, Markdown, text, LaTeX):** read it yourself. For `.docx`/`.doc` on macOS, convert it first with `textutil -convert txt -stdout <file>`. Draft the master JSON following the format and rules in `~/.job-quest/app/skill/references/resume/latex-to-master.md` (copy facts exactly, never invent, leave a field empty when the resume lacks it). Write the draft to a temporary file and run `node ~/.job-quest/app/skill/bin/import-resume.js --json <draft.json>`. If it reports validation errors, fix the draft and run it again.
   
   Both commands print a diff and save nothing.
5. Show the user a short summary: name, roles per employer, bullet counts, projects, skill groups and education. Ask "Does this look right?" and apply any corrections. Then re-run the same command with `--write`.
6. Copy, never move, the source files into `~/.job-quest/data/resume-files/` so the Resume page can show them. For a LaTeX resume, include its `cv-sections/` folder. Leave the originals where they are.

If they have no resume yet, or want to skip, say they can add it later from Dashboard → Resume → Master or by running `/job-quest` and asking to import a resume. Tailoring stays idle until a master exists.

### Phase 4: Configure the Daily Intel Agent

Ask the user about their preferred schedule using AskUserQuestion:
- **How often?** Daily (recommended), weekdays only, or custom
- **What time?** Morning is ideal. Suggest something like 7:03 AM.

Install a **local cron entry** that runs the intel agent on the user's machine. The helper script `~/.job-quest/bin/install-schedule.sh` takes a 5-field cron expression and registers the entry so it survives shell restarts and system reboots:

```bash
# 7:03 AM weekdays
~/.job-quest/bin/install-schedule.sh "3 7 * * 1-5"

# 7:03 AM daily
~/.job-quest/bin/install-schedule.sh "3 7 * * *"
```

The installed entry invokes `~/.job-quest/bin/run-daily-intel.sh`, which reads the user's `profile.json`, builds the personalized intel prompt, runs the active runtime CLI locally, and writes JSON files into `~/.job-quest/data/{intel,quizzes,tasks}/` and `~/.job-quest/data/problems/problems.json`. Logs land in `~/.job-quest/data/logs/daily-intel.log`.

**Why local cron (not `/schedule`/`RemoteTrigger`):** the daily agent must write files to the user's local filesystem so the dashboard at `localhost:3847` can render them. Remote triggers run in Anthropic's cloud and cannot mutate local state.

### Phase 5: Generate Today's Content

Don't make them wait until tomorrow. Run the first intel generation right now, inline in this conversation:

1. **Search the web** for roles matching their profile — aim for 15-20 roles across their target categories
2. **Generate a quiz** — 5-7 questions mixing system design, coding concepts, and behavioral/leadership topics
3. **Create daily tasks** — 8-10 tasks across categories (coding, system-design, behavioral, research, networking, application), each with substantial `content` field
4. **Generate coding problems** — 3-5 problems calibrated to their level

Write all outputs to `~/.job-quest/data/` in the correct JSON formats (see `references/intel-agent-template.md` for schemas).

### Phase 6: Start the Dashboard and Orient

Start the web dashboard via the installed helper:
```bash
~/.job-quest/bin/start.sh --background
```

Tell the user it's running at `http://localhost:3847` and give them a quick tour:

"Your Job Quest command center is live! Here's what you've got:

- **Dashboard** — daily overview with your streak, task progress, and quiz accuracy
- **Intel** — the roles I just found for you, with 'why this fits' analysis for each
- **Tasks** — your daily prep tasks, each with a detailed walkthrough
- **Quiz** — knowledge checks to keep you sharp
- **Code Lab** — coding problems that adapt to your level, with AI code review
- **System Design** — practice Staff-level design discussions with me
- **Role Tracker** — track roles from discovery through offer
- **Behavioral Practice** — STAR framework prep with AI scoring
- **Resume Manager** — edit and compile your resume

Your daily intel agent is scheduled and will generate fresh content every [schedule]. Run `/job-quest` anytime to check in."

### Phase 7 (macOS only, optional): Offer the Menu Bar Plugin

After orienting the user, if they're on macOS, offer the optional xbar menu bar plugin. Use AskUserQuestion:

> "Want to add a Job Quest icon to your menu bar? It shows today's role count, task progress, and lets you start, stop or restart the dashboard or refresh intel from anywhere. Requires xbar (free, open-source)."

Options: "Install now", "Skip for now", "Tell me more".

If they choose **Install now**, run `~/.job-quest/bin/install-xbar.sh`. The script checks for xbar and prints the `brew install --cask xbar` command if it's missing — relay that to the user if it errors. After install, tell them to look for the "JQ" item in their menu bar.

If they choose **Tell me more**, explain: the plugin polls `/api/status` every 5 minutes: running shows progress, stopped shows **JQ ⏸**, and unresponsive shows **JQ ⚠**. It offers Start Server, Stop Server, Restart Server, and Refresh Intel Now; startup checks health and intel runs in the background. View Dashboard Log opens `~/.job-quest/data/logs/dashboard.log`; View Intel Log opens `daily-intel.log` in the same folder. Page shortcuts and unlinked interview sessions open the relevant dashboard page. Remove it with `~/.job-quest/bin/install-xbar.sh --uninstall`.

If xbar isn't installed and the user wants the plugin, ask whether they want to install xbar via Homebrew now or skip until later.

## Returning User Flow

When the user comes back (profile.json exists), read their profile and today's data, then ask what they want to focus on:

```
Welcome back, [name]! Your intel agent ran this morning and found [N] new roles.

What do you want to work on?
1. Review today's intel and track interesting roles
2. Practice interview prep for a specific company
3. Work through today's tasks
4. Take the daily quiz
5. Practice coding problems
6. System design discussion
7. Interview trainer (hourly questions via iMessage)
8. Update my profile or schedule
9. Install or remove the menu bar plugin (macOS)
10. Manage installation (reinstall / uninstall)
```

Use AskUserQuestion to let them pick. Because AskUserQuestion is capped at 4 options per question, split this into two questions or present it as a category chooser first ("What area?" → "Practice", "Review", "Manage setup") then drill into specifics. Then help them with whatever they chose — this skill is their ongoing job search companion, not just a one-time setup.

### Handling Each Return Flow:

**Missing master resume:** on any return visit, if `~/.job-quest/data/resume/master.json` is missing or has no experience, mention once that tailoring is idle and offer to import their resume (Phase 3b).

**Review Intel:** Read `~/.job-quest/data/intel/` for today's file. Present the top roles with fit analysis. Help them add roles to the tracker.

**Interview Prep:** Ask which company/role. Point them to the role's workbook in the dashboard (Intel → the role → Workbook, or the Workbooks tab). If the role has none, create one from the role page ("Create workbook") or with `curl -s -X POST localhost:3847/api/workbooks -H 'content-type: application/json' -d '{"roleKey":"Company|Role"}'`. For deeper onsite prep, use "Expand to onsite". To study together, open `http://localhost:3847/workbooks/<id>` and drill its Review misses list with them. When they want a schedule across days or several interviews ("plan my prep", "I have X Thursday and Y Friday"), follow **Plan Prep** below.

**Daily Tasks:** Read today's task file. Walk through tasks conversationally, helping with each one — expanding on system design topics, role-playing behavioral questions, doing research together.

**Quiz:** Read today's quiz. Present questions one at a time, give feedback after each answer, track accuracy.

**Coding Problems:** Read problems.json and progress.json. Help them pick a problem, discuss approach, review their solution, suggest optimizations.

**System Design:** Pick a topic relevant to their targets. Run a Staff-level design discussion — ask probing questions, push on tradeoffs, evaluate their approach.

**Update Profile:** Re-run the interview for any fields they want to change. Update profile.json and the scheduled task prompt.

**Interview Trainer:** Route to the "Interview Trainer" section below — set it up if `~/.job-quest/data/trainer/config.json` is missing, otherwise review pending questions, adjust hours, pause/resume, or change the delivery handle.

**Manage Installation:** Route to the "Installation Management" section below.

## Prep Output Lives in the Dashboard

Everything you make for the user's prep must be usable at `http://localhost:3847`. Start the dashboard first if it isn't running (`~/.job-quest/bin/start.sh --background`).

| What you made | Where it goes | How |
|---|---|---|
| Study material for a role | A workbook | `POST /api/workbooks` (pass research you already gathered as `research`) |
| Coding drills | Code Lab | `POST /api/problems` (each verified against its tests) |
| A day-by-day schedule | Daily Tasks | `POST /api/tasks/plan` |
| Interview dates, round, stage, notes | The role tracker | `GET /api/role-tracker`, change that role, `POST` the whole object back |
| System design practice | System Design topics | Workbook system design questions appear there automatically; link to them |

Never write prep plans, research notes, drills, question lists or cheat sheets as `.md`/`.txt` files, whether in `~/.job-quest/data/practice/`, the home folder or your own memory. Files in `data/practice/` are older imports: read them as input, never add to them. Research subagents return their findings to you as text; tell them not to write files, then pass the findings to the workbook as `research`. Put summaries in chat, with links to the dashboard pages.

## Plan Prep

Use this when the user wants a schedule, for one interview or several.

1. **Pin down the interviews.** For each one, confirm the company, role, round, date and time, and what's allowed (AI tools, language). Ask how many hours a day they have. Record the dates and the round on the role as a checklist item or note plus a timeline entry. The tracker endpoint replaces the whole tracker, so `GET /api/role-tracker`, change only that role's fields, and `POST` the complete object back. A role missing from the body is deleted.
2. **Make sure every role has a workbook.** Run `GET /api/workbooks`. For a role without one, run `POST /api/workbooks {"roleKey", "tier": "screen" | "onsite", "research"?}`. Pass `research` only if you already did the research: it's markdown that must end with a `## Sources` section listing http(s) links, and the build then skips its own web search. For an onsite after a screen workbook, run `POST /api/workbooks/<id>/expand`. Builds take a while: check `GET /api/workbooks/<id>/job` and tell the user which ones are still generating.
3. **Drills go into Code Lab.** Reuse existing problems first (`GET /api/problems`; company drills carry the company in `tags`). Add new ones with `node ~/.job-quest/app/skill/bin/add-problems.js <file.json>`, which works without the dashboard, or with `POST /api/problems {"problems": [...]}`. Either way, at most 20 per call, and never by editing `problems.json`. Each needs:
   - `id`: a new lowercase slug.
   - `title`, `category` (a slug such as `acme-practice`), `difficulty` (`easy`, `medium` or `hard`), `description` and `starterCode`.
   - `functionName`: a function, or a class driven by `{"operations": [["method", ...args], ...]}` with the expected list of return values.
   - `testCases`: at least two `{"input": {...}, "expected": ...}`.
   - `referenceSolution`: Python that defines `functionName`.

   Optional fields are `examples`, `constraints`, `hints` and `tags` (include the company slug). Both check that the starter matches the tests, then run `referenceSolution` against every test in Code Lab's own runner, and reject the whole batch on any failure; the solution is never stored. Expected errors are written `{"raises": "ValueError"}`. Tree, linked-list and graph problems declare `adapters` instead of converting inside the function. The full rules are in the "Add coding problems" section of `references/intel-agent-template.md`. For a progressive drill, add one problem per part (`acme-spreadsheet-1`, `-2`, …).
4. **The schedule goes into Daily Tasks.** Send the whole plan with `POST /api/tasks/plan {"planId": "prep-2026-10-06", "tasks": [...]}`. Each task has:
   - `date`: `YYYY-MM-DD`, today or later.
   - `text`: one concrete action.
   - `category`: `coding`, `system-design`, `behavioral`, `research`, `networking` or `application`.
   - Optionally `minutes`, `roleKey`, `content` (markdown details) and `link`.

   `link` is what makes a task open the right page:
   - `{"kind": "workbook", "workbookId", "chapter"?}`: chapter ids come from `GET /api/workbooks/<id>/content`.
   - `{"kind": "codelab", "problemId"}`.
   - `{"kind": "sysdesign", "topicId"}`: ids come from `GET /api/sd-topics`.

   The server rejects links to things that don't exist yet, so create workbooks and drills first. A workbook link can point at a workbook that's still generating; leave out `chapter` until it's ready. To revise the plan, send it again with the same `planId`: unfinished tasks are replaced, finished ones are kept, and other tasks (daily intel, interview follow-ups) are untouched.
5. **Report in chat.** Give a short day-by-day summary that names the dashboard pages (Tasks, Workbooks, Code Lab, System Design), and say which workbooks are still building. Offer to start the first block together.

## Workbooks

A workbook is a per-role study guide: teaching chapters written for the user's background, drillable questions (multiple choice, written, and code) with hints, answer keys, and rubrics, a hover glossary, self-grading, and a Review misses list. Workbooks live in `~/.job-quest/data/workbooks/<id>/`.

- **Generation** runs in the background on the dashboard's job queue: a researcher agent, a link check, a curriculum planner, chapter writers, Python checks of every code answer, and an editor. Code validates every agent output; a chapter that fails its checks is never published.
- **Tiers:** `screen` (5–7 chapters) by default; "Expand to onsite" adds 4–8 chapters without touching existing ones.
- **Auto-build:** saving or applying to a role queues a workbook (at most 3 automatic builds a day; extras wait for the next day). Toggle it on the Workbooks tab; "Build for all saved/applied" covers older roles.
- **Progress** is saved on the dashboard, not just in the browser. "Download offline" gives a single HTML file that works without internet.
- **Trainer:** missed workbook questions come back through the hourly trainer on a 1-, 3-, then 7-day schedule, and graded replies update the workbook.
- **Code Lab:** code questions whose tests passed verification show an **Open in Code Lab** button and are listed in Code Lab under "From your workbooks", so they can be run against their tests and reviewed there. Unverified ones (for example, from imported kits without `@@tests`) stay workbook-only.
- **Import** an existing hand-built kit with `~/.job-quest/bin/import-workbook.sh` (see Available Scripts).

## Interview Trainer

The interview trainer sends the user one interview question per hour (default 9am–9pm, every day) via iMessage, tailored to the roles they have **saved, tracked, or applied to** in Job Quest. Questions are deliberately varied — quick coding exercises, targeted technical knowledge, behavioral prompts, and occasionally a tightly scoped system-design question — and sized to be answerable in a text message. The user can answer two ways, and both stay in sync:

- **Reply directly in the iMessage thread.** A background poller (every minute) picks up the reply and the trainer behaves like a real interviewer: scored feedback PLUS one probing follow-up question per round, for up to 3 follow-ups, then a final assessment comparing where the answer started (initial score → final score, with a progress note). Keywords: `skip` passes on the current question, `next` gets a fresh one, `done` ends the exchange with the final assessment.
- **The dashboard's Trainer tab** shows each question as a conversation timeline (answers, per-round feedback, follow-ups) and — once an exchange completes — an "Interview result" summary with the first-answer evaluation, final-answer evaluation, and the score delta. Answering from the dashboard follows the same interviewer flow.

### Setup

1. Ask for the iMessage handle (phone number like `+12065551234`, or Apple ID email) and preferred hour window (default 9–21).
2. Write `~/.job-quest/data/trainer/config.json`:

```json
{
  "enabled": true,
  "phone": "+12065551234",
  "delivery": "imessage",
  "startHour": 9,
  "endHour": 21
}
```

3. Install the hourly schedule:

```bash
~/.job-quest/bin/install-trainer-schedule.sh 9-21
```

4. Run one question immediately so they see it working (`--force` bypasses the hour-window guard):

```bash
~/.job-quest/bin/run-interview-trainer.sh --force
```

5. Warn them: the first iMessage send triggers a macOS Automation permission prompt (System Settings → Privacy & Security → Automation → allow the terminal/launchd process to control Messages). If the send fails with "not authorized", that's the fix.

6. For **reply-by-iMessage**, the user must grant Full Disk Access to the dedicated helper binary — this is a one-time manual step only they can do, and it is scoped to that single-purpose program (never suggest granting FDA to /bin/bash or a terminal): System Settings → Privacy & Security → Full Disk Access → "+" → press Cmd+Shift+G → enter `~/.job-quest/bin/trainer-messages-reader` → Open → toggle on. Until granted, the poller logs "BLOCKED: no Full Disk Access" in `~/.job-quest/data/logs/trainer-replies.log` and questions can only be answered from the dashboard. The helper is compiled from `skill/helpers/trainer-messages-reader.c` by install.sh (requires clang from the Xcode Command Line Tools).

Questions accumulate in `~/.job-quest/data/trainer/questions.json`. The generator reads the profile, saved/applied roles, and the last 20 questions with scores, so it rotates roles/categories and biases toward categories where the user scores low. It needs at least one saved/tracked/applied role — if there are none, it skips and logs.

### Management

- **Pause/resume:** set `enabled` to `false`/`true` in `config.json` (the dashboard Trainer tab also has a toggle). The schedule keeps firing but runs exit immediately while paused.
- **Change hours:** update `startHour`/`endHour` in config.json AND reinstall the schedule: `~/.job-quest/bin/install-trainer-schedule.sh <start>-<end>`.
- **Change handle:** update `phone` in config.json.
- **Remove entirely:** `~/.job-quest/bin/install-trainer-schedule.sh --uninstall`.
- **Status:** `~/.job-quest/bin/install-trainer-schedule.sh --show`; logs at `~/.job-quest/data/logs/interview-trainer.log`.

## Resume Tailoring

Job Quest keeps one structured master resume (`~/.job-quest/data/resume/master.json`) and builds a tailored one-page PDF per role. Each version is graded by a deterministic ATS score (Keywords 30, Parseability 30, Structure 15, History 15, Content 10) and revised up to 3 rounds per run until it scores at least 90. It never adds a number, tool, employer, title, or date that the master does not support.

- **Set up the master:** onboarding imports it (Phase 3b: ask where the resume is, then import it from any format with `import-resume.js --json` or the `content.py` workflow). Later, run `/job-quest` and ask to import a resume, which follows the same steps, or use Dashboard → Resume → Master. Fill it in, or choose "Import from LaTeX" to convert the uploaded `resume_cv.tex`, review the diff, choose "Use this", then Save. If you keep a `content.py`/`build.py` workflow, import it with `node ~/.job-quest/app/skill/bin/import-resume.js --content <content.py> --tex <resume_cv.tex>`; it prints a diff and saves only with `--write`.
- **Tailor:** on a role page choose "Tailor resume". Saving or applying to a role queues one automatically. Turn this off with `PUT /api/settings {"resume":{"autoTailor":false}}`; at most `settings.resume.autoDailyCap` (default 5) automatic runs start per day, and extra ones wait for the next day.
- **When the posting can't be fetched** (closed posting, or a board that renders in the browser), use "Paste JD" on the card.
- **Review:** the card shows the score breakdown, every round, missing keywords (marked "not supported by your master resume" when nothing in the master backs them), and a bullet-by-bullet diff with each bullet's source ID. "Retry" runs up to 3 more rounds with the same frozen keywords. "Accept" adds "Resume tailored (score)" to the role's timeline and links the PDF on applied roles.
- **Requirements:** Tectonic (`brew install tectonic`). Files live in `~/.job-quest/data/resume/tailored/<id>/`. The LaTeX template is `~/.job-quest/data/resume/template/resume_cv.tex` (only its preamble and macros are used).
- **Agents:** a JD analyst lists keywords (code keeps only terms found verbatim in the posting, then freezes them) and a tailor rewrites bullets. Both run read-only through `~/.job-quest/app/skill/bin/run-agent.sh`.
- **Missing technology names:** if a tool slips past the fact guard, add it to `~/.job-quest/app/skill/references/resume/tech-lexicon.txt`.

For a live validation run from a repository checkout, create a fresh directory with `mktemp -d` and import the master there using `node skill/bin/import-resume.js --content <content.py> --tex <resume_cv.tex> --data-dir <temp-data-dir>` (review the diff, then repeat with `--write`). Run `node app/scripts/live-tailor.js <role-url> <temp-data-dir> "<company>" "<role>"`. This uses the authenticated Claude CLI, clears fake/dry-run settings, refuses directories outside the system temp root, and requires a valid imported master. It prints JSON with status, best score/round, categories, gaps, and each round's score/discard reason, tells, and guard counts/rules; inspect the generated PDF before recording validation results.

## Schedule Management

When the user asks to view, change, or restore their schedule, treat it as a dedicated flow rather than burying it inside generic setup.

1. Read the current schedule first:

```bash
~/.job-quest/bin/install-schedule.sh --current-cron
```

If that command fails, assume no schedule is installed.

2. Tell the user the current schedule if one exists. If none exists, say that clearly and recommend the default weekday morning schedule (`3 7 * * 1-5`).

3. Ask what they want:
- Keep weekdays and change only the time
- Switch between weekdays and daily
- Set a fully custom cron expression
- Remove the schedule entirely

4. For common cases, translate their request into cron and apply it with:

```bash
~/.job-quest/bin/install-schedule.sh "<new-cron>"
```

Examples:

```bash
# 8:30 AM weekdays
~/.job-quest/bin/install-schedule.sh "30 8 * * 1-5"

# 7:03 AM daily
~/.job-quest/bin/install-schedule.sh "3 7 * * *"
```

5. If they want the schedule removed, run:

```bash
~/.job-quest/bin/install-schedule.sh --uninstall
```

6. After any change, confirm the new schedule and remind them they can change it again later by asking Job Quest.

## Installation Management

When the user picks "Manage installation" from the menu OR their initial message contained a keyword (`uninstall`, `reinstall`, `reset`, `start over`, `wipe`, `nuke`), present the three management actions via AskUserQuestion:

- **Reinstall** — Clean reset. Runs `~/.job-quest/bin/reinstall.sh --yes` which uninstalls the current installation (stops server, removes skill, data, app, temp files, cron entry) then re-runs `install.sh` from GitHub for a fresh setup. After it completes, onboarding must be re-run via `/job-quest`.
- **Reinstall (keep my data)** — Same as above but runs `~/.job-quest/bin/reinstall.sh --yes --keep-data`, preserving `profile.json`, intel, quizzes, tasks, problems, and progress across the reset. Useful when the app/skill is broken but the user's data is fine.
- **Uninstall** — Full removal. Runs `~/.job-quest/bin/uninstall.sh --yes`. No reinstall. Useful when the user wants to stop using Job Quest entirely.

Before executing, **always confirm in plain language** what's about to happen ("This will remove your app, skill, data, and cron schedule. It cannot be undone. Proceed?"). If they confirm, invoke the script via Bash:

```bash
# Reinstall (destructive — use --yes only after explicit confirmation)
bash ~/.job-quest/bin/reinstall.sh --yes

# Reinstall preserving data
bash ~/.job-quest/bin/reinstall.sh --yes --keep-data

# Uninstall
bash ~/.job-quest/bin/uninstall.sh --yes
```

After a reinstall completes, the runtime skill registrations have been rewritten from the latest `main` branch. Tell them to reopen Job Quest from their runtime entrypoint and start onboarding again. After an uninstall, tell them they can always come back by re-running the install one-liner from the README.

## Available Scripts

The skill installs helper scripts at `~/.job-quest/bin/` that wrap the active runtime CLI. Use these from within Claude, Codex, or the terminal:

### update.sh
Checks whether the installed repo is behind `origin/main` and, if so, refreshes the local install from the latest remote installer. This is what the skill should call first on each invocation.

```bash
~/.job-quest/bin/update.sh --if-needed
~/.job-quest/bin/update.sh --check-only
```

### generate-plan.sh
Runs one prompt file through the active runtime CLI and prints its output. The interview trainer uses it to evaluate replies. (Role prep plans are now workbooks; see the "Workbooks" section.)

```bash
# Use when the user wants interview prep for a specific role
~/.job-quest/bin/generate-plan.sh /tmp/prep-prompt.txt
```

The script prints the runtime's raw reply.

### code-review.sh
Multi-turn code review using the active runtime CLI. Takes a prompt (via argument or stdin) and returns feedback. Used by the Code Lab for reviewing the user's solutions to coding problems.

```bash
# Pipe code for review
echo "Review this solution for the two-sum problem: ..." | ~/.job-quest/bin/code-review.sh
```

### start.sh
Starts the web dashboard server. Automatically sets the data directory.

```bash
~/.job-quest/bin/start.sh
# Dashboard available at http://localhost:3847
```

### run-daily-intel.sh
Runs the daily intel agent locally via the active runtime CLI. Reads `profile.json`, builds a personalized prompt, and writes fresh `intel/`, `quizzes/`, and `tasks/` files for today. Invoked by the cron entry installed via `install-schedule.sh`, but can also be run manually for an on-demand refresh.

```bash
~/.job-quest/bin/run-daily-intel.sh
# Logs to ~/.job-quest/data/logs/daily-intel.log
```

### install-schedule.sh
Installs the daily intel schedule. Uses **launchd on macOS** (no elevated permissions) and **crontab on Linux**. Idempotent — replaces any existing job-quest entry. Pass `--force-cron` on macOS to opt into crontab (triggers a Full Disk Access prompt with a one-click path to System Settings).

```bash
# 7:03 AM weekdays
~/.job-quest/bin/install-schedule.sh "3 7 * * 1-5"

# Show current schedule
~/.job-quest/bin/install-schedule.sh --show

# Exit 0 if a schedule exists
~/.job-quest/bin/install-schedule.sh --exists

# Print the current cron expression
~/.job-quest/bin/install-schedule.sh --current-cron

# Remove the schedule (both launchd and any legacy cron entry)
~/.job-quest/bin/install-schedule.sh --uninstall
```

### run-interview-trainer.sh
Generates one interview question tailored to the user's saved/tracked/applied roles and delivers it via iMessage (see the "Interview Trainer" section). Invoked hourly by the trainer schedule; `--force` bypasses the configured hour window for manual/on-demand runs.

```bash
~/.job-quest/bin/run-interview-trainer.sh --force
# Logs to ~/.job-quest/data/logs/interview-trainer.log
```

### import-workbook.sh
Imports a hand-built study kit (a folder with `content/*.md` chapters in the workbook `@@` format and `content/glossary-*.txt`) as a workbook covering one or more roles. Prints a JSON report with chapter, question, and glossary counts, lint findings (reported, never blocking), and code-answer verification.

```bash
~/.job-quest/bin/import-workbook.sh ~/.job-quest/data/practice/my-kit --roles "Acme|Staff Engineer" --roles "Beta|Senior SWE" --title "Acme + Beta onsite kit"
```

### install-trainer-schedule.sh
Installs the hourly interview-trainer schedule (launchd on macOS, crontab on Linux). Takes an hour range; fires at the top of each hour in that range, every day.

```bash
~/.job-quest/bin/install-trainer-schedule.sh 9-21   # 9am-9pm daily
~/.job-quest/bin/install-trainer-schedule.sh --show
~/.job-quest/bin/install-trainer-schedule.sh --exists
~/.job-quest/bin/install-trainer-schedule.sh --uninstall
```

### uninstall.sh
Full uninstaller. Stops the dashboard, removes the daily schedule (launchd or cron), removes the skill, data, and app directories, and cleans temp files.

```bash
~/.job-quest/bin/uninstall.sh           # with confirmation
~/.job-quest/bin/uninstall.sh --yes     # skip confirmation
~/.job-quest/bin/uninstall.sh --keep-data  # preserve profile/intel/progress
```

### reinstall.sh
One-step clean reset — runs uninstall then re-runs `install.sh` from GitHub.

```bash
~/.job-quest/bin/reinstall.sh --yes
~/.job-quest/bin/reinstall.sh --yes --keep-data
```

### install-xbar.sh (macOS only)
Installs the optional plugin into `~/Library/Application Support/xbar/plugins/job-quest.5m.sh`. Every 5 minutes it shows running progress, stopped (**JQ ⏸**), or unresponsive (**JQ ⚠**) status. Start Server launches in the background and checks health; Stop Server and Restart Server control the dashboard. Refresh Intel Now runs detached. View Dashboard Log opens `~/.job-quest/data/logs/dashboard.log`; View Intel Log opens `daily-intel.log` there. Links open Intel, Daily Tasks, Workbooks (including unlinked interviews), Code Lab, and Trainer. If xbar is missing, installation prints `brew install --cask xbar` and exits non-zero.

```bash
~/.job-quest/bin/install-xbar.sh             # install plugin and refresh xbar
~/.job-quest/bin/install-xbar.sh --status    # print install state
~/.job-quest/bin/install-xbar.sh --uninstall # remove plugin
```

When the user asks to practice coding, prep for an interview, or start the dashboard, use these scripts rather than reimplementing the functionality. They handle runtime detection, shared-home paths, and error logging.

## /interview integration

When the `/interview` live copilot is installed (`~/.interview/app/capture.py` exists), Job Quest prepares its context before a call and imports each finished session afterwards. The two talk only through the `jq-interview/1` contract in `CONTRACT.md`.

- `~/.job-quest/bin/jq` is Job Quest's CLI for `/interview`. It is not the `jq` JSON tool: it lives in `~/.job-quest/bin`, which is never put on `PATH`, and `/interview` runs it by absolute path. It works without the dashboard running. Every command prints one JSON value; failures exit non-zero with `{"error":"<one line>"}`. `version` reports the contract; `roles --company <name>` lists matching roles.
- Before a call: `~/.job-quest/bin/jq interview-context "<Company|Role>" --round <coding|system|behavioral|recruiter|screen>` writes `~/.interview/context/{resume.md,<company>-jd.md,target.md}`, `~/.interview/cheatsheets/<company>.json` (from the role's workbook), and `~/.interview/practice/<roleId>.json` (company plus role slug). Missing inputs are reported under `skipped`; it never waits for workbook generation. `--no-agent` uses only cached cheat sheets. The dashboard's role page has the same action as **Prep /interview**.
- Files without Job Quest's ownership marker (the `generated by job-quest` first line in Markdown or `"_generatedBy":"job-quest"` in JSON) are never overwritten; a `.jq` copy is written beside them, unless that sibling is also user-owned. The returned `cheatsheet` is the target path whenever a file exists there (the user's sheet wins), or `null`; `practice` is the file Job Quest wrote (target or `.jq` sibling), or `null`.
- After a call: `/interview stop` runs `~/.job-quest/bin/jq ingest-session <folder>`. The session lands on the role's timeline, raises the tracker stage (never lowers it), adds the asked questions to the role's workbook chapter "Asked in your interviews" with grades from the debrief (misses enter the trainer queue), and turns follow-ups into tasks. Re-running an unchanged, fully applied session changes nothing. Successful debrief analysis is reused until the session or debrief changes; failed analysis is retried once per edit (at most two attempts for unchanged inputs).
- The dashboard also scans `~/.interview/sessions/` at startup and every 10 minutes. This backstop requires `session.json` and `debrief.md`; a debrief with the scorecard placeholder waits until it has been unmodified for 30 minutes. Records live in `~/.job-quest/data/interview-sessions/` with statuses `unlinked|linking|ingesting|failed|ingested`; the backstop retries failed or interrupted imports.
- Sessions recorded before the integration, or without a role, show under **Unlinked /interview sessions** on the Workbooks tab (collapsed by default; click the header to open it). Hide solo practice or test runs with the ✕ on a row; nothing is deleted, and "Show hidden sessions" lists them with Restore. Pick a role to import the rest (`~/.job-quest/bin/jq link-session <folder> "<Company|Role>"` does the same). `<folder>` is a session folder name or its absolute path. `JOB_QUEST_HOME` and `INTERVIEW_HOME` override the default homes.

## Troubleshooting

- **Dashboard won't start**: Check `node --version` (need 18+), check port 3847 isn't in use
- **No intel today**: Check the cron entry is installed (`~/.job-quest/bin/install-schedule.sh --show`) and check `~/.job-quest/data/logs/daily-intel.log` for errors. Re-run manually with `~/.job-quest/bin/run-daily-intel.sh`.
- **Want to change schedule**: Run `~/.job-quest/bin/install-schedule.sh "<new-cron>"` — it replaces any existing job-quest entry.
- **Remove the schedule entirely**: `~/.job-quest/bin/install-schedule.sh --uninstall`
- **No hourly trainer questions**: Check `~/.job-quest/bin/install-trainer-schedule.sh --show` and `~/.job-quest/data/logs/interview-trainer.log`. Common causes: trainer paused (`enabled: false` in `~/.job-quest/data/trainer/config.json`), no saved/applied roles yet, or the runtime CLI is logged out.
- **Trainer question saved but no iMessage arrives**: The log will show a "not authorized" AppleScript error — grant Automation permission for Messages in System Settings → Privacy & Security → Automation, and confirm Messages.app is signed in.
- **iMessage replies get no feedback**: Check `~/.job-quest/data/logs/trainer-replies.log`. "BLOCKED: no Full Disk Access" → grant FDA to `~/.job-quest/bin/trainer-messages-reader` (see Interview Trainer setup step 6). No log entries at all → the reply poller isn't scheduled; re-run `~/.job-quest/bin/install-trainer-schedule.sh <start>-<end>`. Also note feedback typically takes 1-3 minutes (polling + a short quiet period + evaluation).
