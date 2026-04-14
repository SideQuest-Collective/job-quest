# Job Hunt Command Center

A personal job search dashboard that helps you stay organized and prepared throughout your job hunt. Built with Node.js/Express and a single-page frontend.

## Features

- **Intel Reports** -- Daily curated role discoveries with fit analysis and interview tips
- **Role Tracker** -- Track roles through stages (discovered, applied, interviewing, etc.)
- **Daily Quizzes** -- Technical quiz questions to keep your skills sharp
- **Task Manager** -- Daily to-do lists with completion tracking and streak counter
- **Code Lab** -- Practice coding problems with a built-in Python runner and test harness
- **AI Code Review** -- Get feedback on your solutions via the Claude CLI
- **Interview Prep Plans** -- AI-generated, role-specific interview preparation plans
- **Resume Manager** -- Store and edit your resume (supports LaTeX files)
- **Activity Calendar** -- Visualize your daily progress across all features
- **Application Tracker** -- Keep tabs on where you've applied

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- Python 3 (for the code runner)
- [Claude CLI](https://github.com/anthropics/claude-code) (optional, for AI code review and interview plan generation)

## Getting Started

```bash
# Install dependencies
npm install

# Start the server
./start.sh
# or
node server.js
```

The app runs at **http://localhost:3847**.

## Project Structure

```
app/
├── server.js          # Express API server
├── public/            # Frontend (static HTML/CSS/JS)
├── data/              # JSON data store (auto-created)
│   ├── intel/         # Daily intel reports
│   ├── quizzes/       # Daily quizzes
│   ├── tasks/         # Daily task lists
│   ├── problems/      # Coding problems & progress
│   ├── conversations/ # Code review chat history
│   └── resume-files/  # Uploaded resume files
├── scripts/           # Helper scripts (Claude CLI wrapper)
└── start.sh           # Startup script
```

## API Overview

| Endpoint | Description |
|---|---|
| `GET /api/intel` | All intel reports |
| `GET /api/quizzes/today` | Today's quiz |
| `GET /api/tasks/today` | Today's tasks |
| `GET /api/problems` | Coding problems |
| `POST /api/run-code` | Execute Python code against test cases |
| `POST /api/code-review` | AI code review via Claude |
| `GET /api/progress` | Aggregated stats and streaks |
| `GET /api/activity` | Activity calendar data |
| `GET/POST /api/resume` | Resume data |
| `GET/POST /api/role-tracker` | Role pipeline tracker |

## Data Storage

All data is stored as JSON files in the `data/` directory. No database required.
