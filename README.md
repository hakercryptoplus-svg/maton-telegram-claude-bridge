# Maton Telegram Claude Bridge

A Telegram bot that bridges your chat with [Maton](https://maton.ai) Tasks (Claude Code). Send messages to your AI agent directly from Telegram and receive live updates.

## How It Works

```
Telegram ──► Bot ──► Playwright (Chromium) ──► Maton Tasks ──► Claude Code
```

The bot maintains a persistent browser session logged into Maton, allowing it to send messages to your task and stream the responses back to you on Telegram.

## Features

- Single-user access control (your Telegram ID only)
- Persistent login — survives service restarts
- Live response streaming as Claude types
- One-click deploy to [Render](https://render.com)
- Docker-ready with multi-stage build

## Quick Deploy to Render

1. Fork this repo
2. Go to [Render](https://render.com) → New → Blueprint
3. Connect your fork
4. Set the required environment variables (see below)
5. Deploy!

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from [@BotFather](https://t.me/BotFather) |
| `ALLOWED_TELEGRAM_USER_ID` | Yes | Your Telegram user ID (get from [@userinfobot](https://t.me/userinfobot)) |
| `BROWSER_DATA_DIR` | — | Browser profile path (default: `/data/browser`) |
| `LOG_LEVEL` | — | Logging level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `PORT` | — | HTTP port for health check (default: `10000`) |

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Begin setup or show current status |
| `/status` | Show connection status |
| `/reset` | Reset session and start over |
| `/help` | Show help and available commands |

## Setup Flow

1. Send `/start` to the bot
2. Enter your Maton email address
3. Check your email and paste the magic link
4. Paste your Maton task URL (`https://www.maton.ai/tasks/...`)
5. Start chatting with Claude Code!

## Local Development

```bash
cp .env.example .env
# Fill in your values

npm install
npx playwright install chromium
npm run dev
```

## Architecture Notes

- **Browser automation**: Uses Playwright to control a headless Chromium instance
- **Session persistence**: Browser profile stored on a mounted disk (`/data`)
- **Security**: Access restricted to one Telegram user ID; credentials never stored in Git
- **Limitation**: Relies on Maton's UI selectors — may need updates if Maton redesigns its frontend

## License

MIT
