# opencode-telegram

Telegram bot that bridges your chats to an OpenCode server. Control coding sessions from your phone.

> Not affiliated with the SST/OpenCode team.

<p align="center"><img src="assets/screenshot.PNG" width="400" /></p>

## Requirements

- Node.js 20+
- [OpenCode](https://opencode.ai) installed (`brew install sst/tap/opencode` or equivalent)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

Create `~/.config/opencode/telegram-bot.json`:

```json
{
  "botToken": "your-telegram-bot-token",
  "username": "your-opencode-username",
  "password": "your-opencode-password",
  "allowedFingerprints": ["*"]
}
```

Run the bot from your project directory:

```bash
npm install
npm run start:telegram
```

OpenCode server starts automatically if it is not already running.

## Access control

The bot uses `allowedFingerprints` to authorize users. A fingerprint is your Telegram user ID.

| Value | Behavior |
|-------|----------|
| `[]` or omitted | Deny all (default) |
| `["*"]` | Discovery mode — replies with your fingerprint, no access granted |
| `["123456789"]` | Allowlist — only that user ID can interact |

To find your fingerprint, set `["*"]` and send `/fingerprint` to the bot. Then switch to your user ID:

```json
{
  "allowedFingerprints": ["123456789"]
}
```

## Configuration reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `botToken` | yes | — | Telegram bot token |
| `username` | yes | — | OpenCode server username |
| `password` | yes | — | OpenCode server password |
| `allowedFingerprints` | no | `[]` | Array of authorized Telegram user IDs, or `["*"]` for discovery |
| `baseUrl` | no | `http://127.0.0.1:4096` | OpenCode server URL |
| `model` | no | OpenCode default | Model in `provider/model` format, e.g. `anthropic/claude-sonnet-4-5` |
| `storePath` | no | `~/.local/share/opencode/telegram-sessions.json` | Path to session store |
| `pollIntervalMs` | no | `1000` | Polling interval for session status |
| `pollTimeoutMs` | no | `3600000` | Max wait time per response |

## Commands

- `/start` — create or resume the session for this chat
- `/new <optional_name>` — create a new session
- `/rename <name>` — rename the current session
- `/stop` — abort the current execution
- `/verbose` — toggle progress traces (ON/OFF)
- `/status` — show active session
- `/sessions <optional_filter>` — list sessions, optionally filtered by name
- `/agents` — list available agents
- `/mcp <optional_filter>` — list MCP servers and status
- `/files` — show modified files in the current project
- `/file_<safe_name>` — show details for a specific file
- `/s_<session_id>` — switch active session (from /sessions list)
- `/d_<session_id>` — delete a session
- `/agent_<name>` — switch to a specific agent
- `/mcp_<name>` — toggle MCP connection
- `/restart` — restart the bot via PM2 and send status on startup
- `/fingerprint` — show your Telegram user ID for allowlist setup
- `/help` — show command list

## Real-time progress

The bot uses HTTP polling to monitor session status. With `verbose` ON (default), it sends status updates during execution.

## Multiple sessions

Multiple sessions can run concurrently. While one session is processing a prompt, you can switch to another session and run commands (like `/status`) without waiting. Messages from sessions that are not active are queued and delivered when you switch back to them.

## PM2

```bash
npm run pm2:up               # start both processes
npm run pm2:restart          # restart both
npm run pm2:restart:telegram # restart bot only
npm run pm2:restart:opencode # restart OpenCode only
npm run pm2:down             # stop both
npm run pm2:logs             # tail logs
```