# TimeChek MVP

TimeChek is a lightweight huddle scheduler for teams. It lets people:

- Create a huddle
- Propose availability windows
- Vote for preferred windows
- See a shared schedule with top choices
- Post results or reminder messages to Slack

## Tech stack

- Node.js + Express backend
- SQLite for persistence
- Vanilla HTML/CSS/JS frontend

## Run locally

### 1) Install dependencies

```bash
npm install
```

### 2) (Optional) Configure Slack webhook

Set a default webhook so the UI can post without manually entering one:

```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

### 3) Start the app

```bash
npm start
```

Then open: `http://localhost:3000`

## API highlights

- `POST /api/huddles` — create huddle
- `GET /api/huddles` — list huddles
- `GET /api/huddles/:id` — huddle details with windows and votes
- `POST /api/huddles/:id/windows` — propose a window
- `POST /api/windows/:id/votes` — toggle vote for a voter
- `GET /api/huddles/:id/schedule` — shared schedule view
- `POST /api/huddles/:id/slack/results` — post winning time(s) to Slack
- `POST /api/huddles/:id/slack/reminder` — post reminder with top options

## Test

```bash
npm test
```
