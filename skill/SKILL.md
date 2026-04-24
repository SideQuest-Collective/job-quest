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

<first_run_detection>
First, check the user's raw input for an **installation management keyword**. If their message contains (case-insensitive) any of: `uninstall`, `reinstall`, `reset`, `nuke my install`, `start over`, `wipe everything`, route immediately to the "Installation Management" section below — do not run onboarding, do not show the menu. This lets users type `/job-quest reinstall` and skip straight to the action.

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
  "yearsExperience": 8,
  "strengths": ["distributed systems", "measurement", "data pipelines"],
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

Seed empty JSON files so nothing crashes on first read:
```bash
echo '[]' > ~/.job-quest/data/problems/problems.json
echo '{}' > ~/.job-quest/data/problems/progress.json
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
~/.job-quest/bin/start.sh &
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
7. Update my profile or schedule
8. Manage installation (reinstall / uninstall)
```

Use AskUserQuestion to let them pick. Because AskUserQuestion is capped at 4 options per question, split this into two questions or present it as a category chooser first ("What area?" → "Practice", "Review", "Manage setup") then drill into specifics. Then help them with whatever they chose — this skill is their ongoing job search companion, not just a one-time setup.

### Handling Each Return Flow:

**Review Intel:** Read `~/.job-quest/data/intel/` for today's file. Present the top roles with fit analysis. Help them add roles to the tracker.

**Interview Prep:** Ask which company/role. Search the web for company-specific intel, recent interview reports, and generate a tailored prep plan with technical questions, behavioral prompts, and a readiness checklist. Save to role-tracker.

**Daily Tasks:** Read today's task file. Walk through tasks conversationally, helping with each one — expanding on system design topics, role-playing behavioral questions, doing research together.

**Quiz:** Read today's quiz. Present questions one at a time, give feedback after each answer, track accuracy.

**Coding Problems:** Read problems.json and progress.json. Help them pick a problem, discuss approach, review their solution, suggest optimizations.

**System Design:** Pick a topic relevant to their targets. Run a Staff-level design discussion — ask probing questions, push on tradeoffs, evaluate their approach.

**Update Profile:** Re-run the interview for any fields they want to change. Update profile.json and the scheduled task prompt.

**Manage Installation:** Route to the "Installation Management" section below.

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
Generates a role-specific interview prep plan using the active runtime CLI. Takes a prompt file as input and returns structured JSON with technical questions, behavioral questions, quiz, system design prompts, and a readiness checklist.

```bash
# Use when the user wants interview prep for a specific role
~/.job-quest/bin/generate-plan.sh /tmp/prep-prompt.txt
```

The prompt file should contain the role details (company, title, level, fit analysis, tips). The script outputs JSON that can be saved to the role tracker.

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

# Remove the schedule (both launchd and any legacy cron entry)
~/.job-quest/bin/install-schedule.sh --uninstall
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

When the user asks to practice coding, prep for an interview, or start the dashboard, use these scripts rather than reimplementing the functionality. They handle runtime detection, shared-home paths, and error logging.

## Troubleshooting

- **Dashboard won't start**: Check `node --version` (need 18+), check port 3847 isn't in use
- **No intel today**: Check the cron entry is installed (`~/.job-quest/bin/install-schedule.sh --show`) and check `~/.job-quest/data/logs/daily-intel.log` for errors. Re-run manually with `~/.job-quest/bin/run-daily-intel.sh`.
- **Want to change schedule**: Run `~/.job-quest/bin/install-schedule.sh "<new-cron>"` — it replaces any existing job-quest entry.
- **Remove the schedule entirely**: `~/.job-quest/bin/install-schedule.sh --uninstall`
