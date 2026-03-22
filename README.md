# EJClaw

Dual-agent AI assistant (Claude Code + Codex) over Discord.

Forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), heavily customized for production use.

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
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Claude Agent SDK
                                          └──► Codex App-Server (JSON-RPC)
                                                    ├── thread/start, thread/resume
                                                    ├── turn/start (streaming, multimodal)
                                                    └── turn/steer (mid-turn injection)

Agent ──► Bash ──► agent-browser (gstack browse)
                        ├── goto, snapshot, click, fill
                        ├── screenshot, pdf, responsive
                        └── persistent Chromium daemon (~100ms/cmd)
```

## Directory Layout

```
ejclaw/
├── src/
│   ├── index.ts              # Orchestrator: state, message loop, agent invocation
│   ├── agent-runner.ts       # Spawns agent processes, manages env/sessions/skills
│   ├── group-queue.ts        # Per-group concurrency, priority queue
│   ├── router.ts             # Outbound message formatting and routing
│   ├── db.ts                 # SQLite operations (WAL mode, shared access)
│   ├── config.ts             # Paths, intervals, trigger patterns
│   └── channels/
│       └── discord.ts        # Discord: mentions, images, typing, voice transcription
├── runners/
│   ├── agent-runner/         # Claude Code runner (Agent SDK)
│   ├── codex-runner/         # Codex runner (app-server JSON-RPC)
│   └── skills/
│       └── agent-browser/    # Browser automation (gstack browse wrapper)
├── groups/{name}/            # Per-group memory (CLAUDE.md)
├── data/sessions/            # Per-group agent sessions
├── store/                    # SQLite database
└── prompts/                  # Platform-level system prompts
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
systemctl --user enable nanoclaw nanoclaw-codex
systemctl --user start nanoclaw nanoclaw-codex

# Logs
journalctl --user -u nanoclaw -f
journalctl --user -u nanoclaw-codex -f
```

## Development

```bash
npm run build                # Build main project
npm run build:runners        # Install + build both runners
npm run dev                  # Dev mode with hot reload
npm test                     # Run tests
```

## License

MIT — Based on [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
