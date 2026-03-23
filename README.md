# EJClaw

![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.81-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.116.0-green)
![Node](https://img.shields.io/badge/Node-20+-339933?logo=nodedotjs&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

Dual-agent AI assistant (Claude Code + Codex) over Discord.

Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), now maintained as EJClaw for personal production use.

## Overview

Two AI agents running as parallel systemd services on a single host:

- **Claude Code** (`@claude`) — Anthropic Agent SDK, adaptive thinking, Opus/Sonnet
- **Codex** (`@codex`) — OpenAI Codex app-server (JSON-RPC), GPT-5.4, xhigh reasoning

Both share the same codebase (`dist/index.js`), differentiated by environment variables. No containers — direct host processes for zero overhead.

## Features

- **Dual-agent architecture** — Claude Code + Codex as parallel services, shared SQLite (WAL mode)
- **Browser automation** — [gstack browse](https://github.com/garrytan/gstack) skill, headless Chromium daemon, ~100ms/command
- **Voice transcription** — Groq Whisper (primary) / OpenAI Whisper (fallback), shared file cache with dedup
- **Bidirectional images** — receive Discord attachments as multimodal input, send screenshots back
- **MCP integration** — Memento (persistent cross-session memory)
- **Skill sync** — single source of truth, auto-synced to all agent sessions
- **Priority queue** — per-group serialization, global concurrency limit
- **Session persistence** — resume conversations across restarts
- **Scheduled tasks** — cron/interval/once via MCP tool
- **Mid-turn steering** — inject follow-up messages while agent is working (both agents)

## Architecture

```
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Claude Code (Agent SDK, MessageStream)
                                          └──► Codex (App-Server, JSON-RPC)
                                          │
                                     IPC polling ◄── follow-up messages (mid-turn steering)
                                          │
                                     Router ──► Discord (text, images, files)

Each agent has access to:
  ├── MCP tools (send_message, schedule_task, watch_ci, ...)
  ├── Bash skills (agent-browser → gstack browse, persistent Chromium)
  └── Per-group memory (CLAUDE.md / AGENTS.md)
```

## Setup

### Prerequisites

- Linux (Ubuntu 22.04+) or macOS
- Node.js 20+ (fnm recommended)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)
- Bun 1.0+ (for browser automation)
- Discord bot token

### Install

```bash
git clone https://github.com/phj1081/EJClaw.git
cd EJClaw
npm install
npm run build:runners
npm run build
```

### Environment

```bash
# .env
DISCORD_BOT_TOKEN=           # Discord bot token
ASSISTANT_NAME=claude        # Bot trigger name (@claude)
CLAUDE_CODE_OAUTH_TOKEN=     # Claude Code OAuth token
OPENAI_API_KEY=              # For Codex
GROQ_API_KEY=                # Voice transcription (Groq Whisper)
```

### Systemd Services (Linux)

```bash
systemctl --user enable ejclaw ejclaw-codex
systemctl --user start ejclaw ejclaw-codex

# Logs
journalctl --user -u ejclaw -f
journalctl --user -u ejclaw-codex -f
```

## Development

```bash
npm run build                # Build main project
npm run build:runners        # Install + build both runners
npm run dev                  # Dev mode with hot reload
npm test                     # Run tests
```

## License

MIT — Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
