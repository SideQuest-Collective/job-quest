---
name: job-quest
description: Your personal job hunt command center — AI-powered daily intel, interview prep, coding practice, and role tracking. Use this skill when the user wants to organize their job search, get daily job recommendations, practice interviews, track applications, or mentions wanting help finding their next role. Triggers on "job quest", "get a job", "job hunting", "interview prep", "job search setup", or any request about structuring a job search. Even if the user just casually mentions looking for a new role, this skill can help.
---

<objective>
Set up and run a personalized job hunt command center. This is a conversational onboarding experience — you're the user's job search coach. Walk them through setup, learn about their background, configure their daily intel agent, and get them started with their first prep session.
</objective>

<execution_context>
@$HOME/.claude/job-quest/references/intel-agent-template.md
</execution_context>

<first_run_detection>
Check if `~/.claude/job-quest/profile.json` exists.
- If it does NOT exist → this is a first run. Start the full onboarding flow below.
- If it DOES exist → the user is returning. Read their profile and ask what they want to do today (review intel, prep for an interview, practice coding, check progress, update their profile, etc).
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

Once confirmed, save to `~/.claude/job-quest/profile.json`:
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

Create the full directory structure at `~/.claude/job-quest/`:

```bash
mkdir -p ~/.claude/job-quest/{intel,quizzes,tasks,problems,behavioral,conversations,sd-conversations,resume-files}
```

Seed empty JSON files so nothing crashes on first read:
```bash
echo '[]' > ~/.claude/job-quest/problems/problems.json
echo '{}' > ~/.claude/job-quest/problems/progress.json
echo '[]' > ~/.claude/job-quest/behavioral/answers.json
echo '{}' > ~/.claude/job-quest/role-tracker.json
echo '{"saved":[],"skipped":[],"applied":[]}' > ~/.claude/job-quest/role-actions.json
echo '[]' > ~/.claude/job-quest/activity.json
echo '{}' > ~/.claude/job-quest/progress.json
echo '{}' > ~/.claude/job-quest/resume.json
```

### Phase 3: Set Up the Dashboard App

Check if Node.js 18+ is installed (`node --version`). If not, walk the user through installing it for their platform.

Then clone and install the web dashboard:
```bash
git clone https://github.com/SideQuest-Collective/job-quest.git ~/job-quest
cd ~/job-quest && npm install
```

Configure it to use the shared data directory:
```bash
echo "DATA_DIR=~/.claude/job-quest" > ~/job-quest/.env
```

If the user already has the app installed somewhere, skip cloning — just confirm the path and create the `.env` file.

### Phase 4: Configure the Daily Intel Agent

Ask the user about their preferred schedule using AskUserQuestion:
- **How often?** Daily (recommended), weekdays only, or custom
- **What time?** Morning is ideal. Suggest something like 7:03 AM.

Install a **local cron entry** that runs the intel agent on the user's machine. The helper script `~/.claude/job-quest/bin/install-schedule.sh` takes a 5-field cron expression and registers the entry so it survives shell restarts and system reboots:

```bash
# 7:03 AM weekdays
~/.claude/job-quest/bin/install-schedule.sh "3 7 * * 1-5"

# 7:03 AM daily
~/.claude/job-quest/bin/install-schedule.sh "3 7 * * *"
```

The installed entry invokes `~/.claude/job-quest/bin/run-daily-intel.sh`, which reads the user's `profile.json`, builds the personalized intel prompt, runs `claude -p` locally, and writes JSON files directly into `~/.claude/job-quest/{intel,quizzes,tasks}/` and appends to `problems/problems.json`. Logs land in `~/.claude/job-quest/logs/daily-intel.log`.

**Why local cron (not `/schedule`/`RemoteTrigger`):** the daily agent must write files to the user's local filesystem so the dashboard at `localhost:3847` can render them. Remote triggers run in Anthropic's cloud and cannot mutate local state.

### Phase 5: Generate Today's Content

Don't make them wait until tomorrow. Run the first intel generation right now, inline in this conversation:

1. **Search the web** for roles matching their profile — aim for 15-20 roles across their target categories
2. **Generate a quiz** — 5-7 questions mixing system design, coding concepts, and behavioral/leadership topics
3. **Create daily tasks** — 8-10 tasks across categories (coding, system-design, behavioral, research, networking, application), each with substantial `content` field
4. **Generate coding problems** — 3-5 problems calibrated to their level

Write all outputs to `~/.claude/job-quest/` in the correct JSON formats (see `references/intel-agent-template.md` for schemas).

### Phase 6: Start the Dashboard and Orient

Start the web dashboard:
```bash
cd ~/job-quest && DATA_DIR=~/.claude/job-quest node server.js &
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
```

Use AskUserQuestion to let them pick. Then help them with whatever they chose — this skill is their ongoing job search companion, not just a one-time setup.

### Handling Each Return Flow:

**Review Intel:** Read `~/.claude/job-quest/intel/` for today's file. Present the top roles with fit analysis. Help them add roles to the tracker.

**Interview Prep:** Ask which company/role. Search the web for company-specific intel, recent interview reports, and generate a tailored prep plan with technical questions, behavioral prompts, and a readiness checklist. Save to role-tracker.

**Daily Tasks:** Read today's task file. Walk through tasks conversationally, helping with each one — expanding on system design topics, role-playing behavioral questions, doing research together.

**Quiz:** Read today's quiz. Present questions one at a time, give feedback after each answer, track accuracy.

**Coding Problems:** Read problems.json and progress.json. Help them pick a problem, discuss approach, review their solution, suggest optimizations.

**System Design:** Pick a topic relevant to their targets. Run a Staff-level design discussion — ask probing questions, push on tradeoffs, evaluate their approach.

**Update Profile:** Re-run the interview for any fields they want to change. Update profile.json and the scheduled task prompt.

## Available Scripts

The skill installs helper scripts at `~/.claude/job-quest/bin/` that wrap the Claude CLI for common tasks. Use these from within Claude Code or from the terminal:

### generate-plan.sh
Generates a role-specific interview prep plan using Claude CLI. Takes a prompt file as input and returns structured JSON with technical questions, behavioral questions, quiz, system design prompts, and a readiness checklist.

```bash
# From Claude Code — use when the user wants interview prep for a specific role
~/.claude/job-quest/bin/generate-plan.sh /tmp/prep-prompt.txt
```

The prompt file should contain the role details (company, title, level, fit analysis, tips). The script outputs JSON that can be saved to the role tracker.

### code-review.sh
Multi-turn code review using Claude CLI. Takes a prompt (via argument or stdin) and returns feedback. Used by the Code Lab for reviewing the user's solutions to coding problems.

```bash
# Pipe code for review
echo "Review this solution for the two-sum problem: ..." | ~/.claude/job-quest/bin/code-review.sh
```

### start.sh
Starts the web dashboard server. Automatically sets the data directory.

```bash
~/.claude/job-quest/bin/start.sh
# Dashboard available at http://localhost:3847
```

### run-daily-intel.sh
Runs the daily intel agent locally via `claude -p`. Reads `profile.json`, builds a personalized prompt, and writes fresh `intel/`, `quizzes/`, and `tasks/` files for today. Invoked by the cron entry installed via `install-schedule.sh`, but can also be run manually for an on-demand refresh.

```bash
~/.claude/job-quest/bin/run-daily-intel.sh
# Logs to ~/.claude/job-quest/logs/daily-intel.log
```

### install-schedule.sh
Installs a crontab entry that runs `run-daily-intel.sh` on a schedule. Idempotent — replaces any existing job-quest entry.

```bash
# 7:03 AM weekdays
~/.claude/job-quest/bin/install-schedule.sh "3 7 * * 1-5"

# Show current schedule
~/.claude/job-quest/bin/install-schedule.sh --show

# Remove the schedule
~/.claude/job-quest/bin/install-schedule.sh --uninstall
```

When the user asks to practice coding, prep for an interview, or start the dashboard, use these scripts rather than reimplementing the functionality. They handle Claude CLI detection, nvm loading, and error logging.

## Troubleshooting

- **Dashboard won't start**: Check `node --version` (need 18+), check port 3847 isn't in use
- **No intel today**: Check the cron entry is installed (`~/.claude/job-quest/bin/install-schedule.sh --show`) and check `~/.claude/job-quest/logs/daily-intel.log` for errors. Re-run manually with `~/.claude/job-quest/bin/run-daily-intel.sh`.
- **Want to change schedule**: Run `~/.claude/job-quest/bin/install-schedule.sh "<new-cron>"` — it replaces any existing job-quest entry.
- **Remove the schedule entirely**: `~/.claude/job-quest/bin/install-schedule.sh --uninstall`
