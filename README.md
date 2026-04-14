# Job Quest

Your personal job hunt command center — AI-powered daily intel, interview prep, coding practice, and role tracking.

Job Quest is a Claude Code skill that sets up a complete job search system on your machine. It includes:

- **Daily Intelligence Agent** — a scheduled Claude task that discovers relevant roles, generates personalized quizzes, creates prep tasks, and adapts coding problems to your skill level
- **Web Dashboard** — a local app for tracking roles, practicing interviews, solving coding problems, and managing your job search pipeline
- **Conversational Coach** — use `/job-quest` anytime in Claude Code to review intel, prep for interviews, practice system design, or update your profile

## Installation

```bash
# Clone and install
git clone https://github.com/SideQuest-Collective/job-quest.git ~/job-quest
cd ~/job-quest

# Install the Claude Code skill
cp -r skill/SKILL.md ~/.claude/skills/job-quest/SKILL.md
mkdir -p ~/.claude/job-quest/references
cp skill/references/intel-agent-template.md ~/.claude/job-quest/references/

# Install the web dashboard
cd app && npm install
```

Then open Claude Code and run `/job-quest` to start the conversational onboarding.

## How It Works

### First Run
When you invoke `/job-quest` for the first time, Claude walks you through a conversational onboarding:

1. **Profile Interview** — Tell Claude about your background, target roles, and what matters to you
2. **Dashboard Setup** — The web app gets configured with your data directory
3. **Daily Intel Agent** — A scheduled task gets created on your preferred schedule
4. **First Content** — Claude generates your first batch of roles, quizzes, tasks, and coding problems right away

### Daily Use
Each day, your intel agent runs automatically and generates:
- 15-20 new roles matching your profile with personalized "why this fits" analysis
- 5-7 quiz questions (system design, coding, behavioral)
- 8-10 prep tasks with detailed walkthroughs
- 3-5 adaptive coding problems calibrated to your level

Run `/job-quest` to check in, review intel, practice interviews, or work through tasks.

### Web Dashboard
Start the dashboard with:
```bash
cd ~/job-quest/app
DATA_DIR=~/.claude/job-quest node server.js
```
Open `http://localhost:3847` for a visual overview of your job search.

## Dashboard Features

| Feature | Description |
|---------|-------------|
| **Intel** | Daily role discoveries with fit analysis |
| **Tasks** | Prep tasks across 6 categories with detailed walkthroughs |
| **Quiz** | Daily knowledge checks with explanations |
| **Code Lab** | Adaptive coding problems with test runner and AI code review |
| **System Design** | Practice Staff-level design discussions |
| **Interview Prep** | Company-specific prep plans with technical + behavioral questions |
| **Behavioral Practice** | STAR framework templates with AI scoring |
| **Role Tracker** | Pipeline CRM from discovery through offer |
| **Resume Manager** | LaTeX editor with live PDF compilation |
| **Activity Calendar** | Track your streak and daily progress |

## Requirements

- **Node.js 18+** — for the web dashboard
- **Claude Code CLI** — for the skill and daily intel agent
- **Python 3** (optional) — for the code execution sandbox
- **tectonic** (optional) — for LaTeX resume compilation

## Data Storage

All user data lives in `~/.claude/job-quest/` — your profile, intel reports, quizzes, tasks, coding problems, and progress. This keeps data separate from the app source code and follows the Claude Code skill data convention.

## License

MIT
