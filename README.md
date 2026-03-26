# EJClaw

![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.81-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.115.0-green)
![Node](https://img.shields.io/badge/Node-20+-339933?logo=nodedotjs&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

Dual-agent AI assistant (Claude Code + Codex) over Discord.

Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), now maintained as EJClaw for personal production use.

## Overview

Two AI agents running as parallel systemd services on a single host:

- **Claude Code** (`@claude`) — Anthropic Agent SDK, adaptive thinking, Opus/Sonnet
- **Codex** (`@codex`) — OpenAI Codex SDK (`codex exec`), GPT-5.4, xhigh reasoning

Both share the same codebase (`dist/index.js`), differentiated by environment variables. No containers — direct host processes for zero overhead.

## Features

- **Dual-agent architecture** — Claude Code + Codex as parallel services, shared SQLite (WAL mode)
- **Browser automation** — [gstack browse](https://github.com/garrytan/gstack) skill, headless Chromium daemon, ~100ms/command
- **Voice transcription** — Groq Whisper (primary) / OpenAI Whisper (fallback), shared file cache with dedup
- **Bidirectional images** — receive Discord attachments as multimodal input, send screenshots back
- **Provider fallback** — Claude 429 → configurable fallback provider (e.g. Kimi K2.5) with cooldown
- **CI monitoring** — `watch_ci` MCP tool for GitHub Actions run polling (structured fast path, no LLM token cost)
- **Usage dashboard** — real-time token usage and service status overview
- **MCP integration** — Memento (persistent memory) + EJClaw host tools (send_message, schedule_task, watch_ci, etc.)
- **Skill sync** — single source of truth, auto-synced to all agent sessions
- **Priority queue** — per-group serialization, global concurrency limit
- **Session persistence** — resume conversations across restarts
- **Scheduled tasks** — cron/interval/once via MCP tool
- **Mid-turn steering** — inject follow-up messages while agent is working (both agents)

## Architecture

```
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Claude Code (Agent SDK, MessageStream)
                                          └──► Codex (Codex SDK, codex exec)
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
- Node.js 20+ (24 recommended, fnm for version management)
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
CLAUDE_CODE_OAUTH_TOKEN=     # Claude Code OAuth token (primary)
CLAUDE_CODE_OAUTH_TOKENS=    # Comma-separated tokens for multi-account rotation
OPENAI_API_KEY=              # For Codex
GROQ_API_KEY=                # Voice transcription (Groq Whisper)

# Provider fallback (optional)
FALLBACK_PROVIDER_NAME=      # e.g. kimi
FALLBACK_BASE_URL=           # e.g. https://api.kimi.com/coding
FALLBACK_AUTH_TOKEN=         # Fallback provider API key
FALLBACK_MODEL=              # e.g. kimi-k2.5
```

### Codex Service (optional)

To run the Codex agent alongside Claude, create `.env.codex`:

```bash
# .env.codex
DISCORD_BOT_TOKEN=               # Separate Discord bot token for Codex
```

The setup step (`npm run setup -- --step service`) auto-detects `.env.codex` and installs `ejclaw-codex` alongside `ejclaw`. Additional Codex settings (`CODEX_MODEL`, `CODEX_EFFORT`, etc.) can be added to `.env.codex` or as `Environment=` lines in the systemd unit.

### Authentication

Multi-account OAuth token rotation is supported via `CLAUDE_CODE_OAUTH_TOKENS` (comma-separated). When one account hits a rate limit, the system automatically rotates to the next.

Token auto-refresh runs on the Claude service only, refreshing access tokens 30 minutes before expiry using rotating refresh tokens from `~/.claude/.credentials.json` (account 0) and `~/.claude-accounts/{n}/.credentials.json` (account 1+). Generate tokens with `claude setup-token` (account 0) or `CLAUDE_CONFIG_DIR=~/.claude-accounts/{n} claude setup-token` (account 1+).

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
