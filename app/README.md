# Job Quest Dashboard

The dashboard is a local Express app that reads and writes Job Quest data from the shared product home.

## Runtime Expectations

- The dashboard server runs from `~/.job-quest/app/app/`
- Data lives in `~/.job-quest/data/`
- Runtime selection comes from `~/.job-quest/config/runtime.json`
- AI-backed endpoints use the active runtime CLI rather than a Claude-only wrapper

## Start

From an installed Job Quest home:

```bash
~/.job-quest/bin/start.sh
```

For local repo development:

```bash
cd app
npm install
DATA_DIR="$HOME/.job-quest/data" node server.js
```

## Key Features

- Intel and role tracking
- Daily quizzes and tasks
- Coding practice with local execution
- Runtime-aware interview-plan generation
- Runtime-aware code review and editing flows
- Resume upload, edit, and compile

## Important Paths

```text
app/
├── public/         # single-page frontend
├── scripts/        # wrappers that delegate to the shared runtime-aware shell scripts
└── server.js       # Express API server
```

## API Highlights

- `GET /api/runtime` — current runtime metadata used by the UI
- `GET /api/job-status` — latest content/schedule status plus runtime-aware install command hint
- `POST /api/interview-plan` — runtime-backed plan generation
- `POST /api/code-review` — runtime-backed conversational review
- `POST /api/resume/edit` — runtime-backed file editing
