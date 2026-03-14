# Sheldon Control Panel

A local web-based control panel for managing your [OpenClaw](https://openclaw.ai) AI agency.

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Agents** — View, create, edit, and delete openclaw agents. Edit system prompts with a live markdown preview and swap models on the fly.
- **Tasks** — Kanban board for tracking work across agents. Organize by project, priority, and status.
- **Chat** — Send messages directly to your main agent from the browser.
- **Metrics** — Track requests, token usage, estimated cost, and per-agent call counts.
- **Skills** — Browse and install openclaw skills.
- **Logs** — Live-streamed gateway logs via WebSocket.
- **Gateway control** — Start, restart, or stop the openclaw gateway from the sidebar.

## Requirements

- [Node.js](https://nodejs.org) 18+
- [OpenClaw](https://openclaw.ai) installed and configured (`~/.openclaw/openclaw.json`)

## Setup

```bash
git clone https://github.com/ahcreative92/sheldon-panel.git
cd sheldon-panel
npm install
npm start
```

Then open **http://localhost:3131** in your browser.

## Project Structure

```
sheldon-panel/
├── server.js        # Express API + WebSocket log streaming
└── public/
    └── index.html   # Single-page frontend
```

The server reads from and writes to `~/.openclaw/` — the same directory openclaw uses — so changes made in the panel take effect immediately.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Gateway running status |
| POST | `/api/gateway/:action` | `start` / `stop` / `restart` gateway |
| GET | `/api/agents` | List all agents |
| POST | `/api/agents` | Create agent |
| PUT | `/api/agents/:name/system` | Update system prompt |
| PUT | `/api/agents/:name/model` | Update model |
| DELETE | `/api/agents/:name` | Delete agent |
| GET | `/api/tasks` | List tasks |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/chat` | Send message to main agent |
| GET | `/api/metrics` | Usage metrics |
| GET | `/api/skills` | List installed skills |
| POST | `/api/skills/install` | Install a skill |
| GET | `/api/logs` | Last 150 lines of gateway log |
| GET | `/api/config` | OpenClaw config (keys redacted) |

## Security Notes

This panel is intended to run locally. It is not hardened for public exposure:
- No authentication
- Binds to all interfaces on port 3131

If you need to access it remotely, put it behind a reverse proxy with authentication (e.g. nginx + basic auth).
