# TimeChek MVP

TimeChek is a lightweight huddle scheduler for teams. It lets people:

- Create a huddle
- Propose availability windows
- Vote for preferred windows
- See a shared schedule with top choices
- Post results or reminder messages to Slack
- **Find a common meeting time across a whole Slack channel** with `/find-time`

## Tech stack

- Node.js + Express backend
- SQLite for persistence
- Vanilla HTML/CSS/JS frontend

## Run locally

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | Optional | Incoming Webhook for the legacy result/reminder post endpoints |
| `SLACK_BOT_TOKEN` | Required for `/find-time` | Bot OAuth token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Required for `/find-time` | App signing secret for request verification |
| `PORT` | Optional | HTTP port (default `3000`) |

### 3) Start the app

```bash
npm start
```

Then open: `http://localhost:3000`

---

## `/find-time` Slack feature

### What it does

1. Someone types `/find-time` in a channel.
2. A modal pops up for them immediately. An announcement with a **Submit My Availability** button is posted to the channel so everyone else can open their own modal.
3. Each person selects:
   - **Timezone** (Eastern, Central, Mountain, Pacific, and more)
   - **Date**
   - **Available from / until** (time pickers)
4. Once everyone has submitted **or** someone types `/find-time-end`, the bot posts the results:
   - If there is a common window, each person's local equivalent of that window is shown.
   - If there is no overlap, each person's individual window is shown for comparison.
   - Current Slack presence (online / away) for each participant is included.

### Setting up the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. **Bot Token Scopes** (OAuth & Permissions → Scopes → Bot Token Scopes):
   - `chat:write` — post messages to channels
   - `commands` — handle slash commands
   - `channels:read` — read public channel membership
   - `groups:read` — read private channel membership
   - `users:read` — read user presence
3. **Slash Commands** (Slash Commands → Create New Command):
   - `/find-time` → Request URL: `https://<your-host>/slack/commands`
   - `/find-time-end` → Request URL: `https://<your-host>/slack/commands`
4. **Interactivity** (Interactivity & Shortcuts → On):
   - Request URL: `https://<your-host>/slack/interactive`
5. Install the app to your workspace, copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN`.
6. Copy the **Signing Secret** (Basic Information → App Credentials) → `SLACK_SIGNING_SECRET`.
7. Invite the bot to your channel: `/invite @YourBotName`.

---

## API highlights

- `POST /api/huddles` — create huddle
- `GET /api/huddles` — list huddles
- `GET /api/huddles/:id` — huddle details with windows and votes
- `POST /api/huddles/:id/windows` — propose a window
- `POST /api/windows/:id/votes` — toggle vote for a voter
- `GET /api/huddles/:id/schedule` — shared schedule view
- `POST /api/huddles/:id/slack/results` — post winning time(s) to Slack (webhook)
- `POST /api/huddles/:id/slack/reminder` — post reminder with top options (webhook)
- `POST /slack/commands` — Slack slash command handler (`/find-time`, `/find-time-end`)
- `POST /slack/interactive` — Slack interactive component handler (modal submissions, button clicks)

## Test

```bash
npm test
```

