# EJClaw

![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.81-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.115.0-green)
![Node](https://img.shields.io/badge/Node-20+-339933?logo=nodedotjs&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

Dual-agent AI assistant (Claude Code + Codex) over Discord with autonomous paired review.

Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), now maintained as EJClaw for personal production use.
Prompt design inspired by [Q00/ouroboros](https://github.com/Q00/ouroboros), adapted for EJClaw's Discord and dual-service workflow.

## Overview

A single unified service (`ejclaw`) manages three Discord bots in one process:

- **Codex-main** (`@codex`) — Owner agent. Handles user requests, writes code.
- **Claude** (`@claude`) — Reviewer agent. Critically reviews owner's work, verifies design direction.
- **Codex-review** (`@codex-review`) — Fallback reviewer. Takes over when Claude hits rate limits (429).

Owner and reviewer agent types are configurable via `OWNER_AGENT_TYPE` and `REVIEWER_AGENT_TYPE` in `.env`.

## Paired Review

The core workflow is an autonomous owner-reviewer ping-pong:

```
User message
  → Owner responds (implementation, answer, etc.)
    → Reviewer auto-triggered (critical review, design check)
      → Verdict:
          DONE              → Owner gets final turn to finalize → Task completed
          DONE_WITH_CONCERNS → Owner addresses feedback → Reviewer re-reviews
          BLOCKED            → Escalate to user (needs decision)
          NEEDS_CONTEXT      → Escalate to user (missing information)
```

The system stops autonomously when the reviewer approves or escalates. No manual intervention needed for the happy path.

## Features

- **Paired review** — Autonomous owner/reviewer ping-pong with verdict-based control
- **Configurable agent types** — Owner and reviewer roles independently set to `claude-code` or `codex`
- **Reviewer fallback** — Claude 429/exhaustion → automatic handoff to codex-review
- **Voice transcription** — Groq Whisper (primary) / OpenAI Whisper (fallback), shared file cache with dedup
- **Bidirectional images** — Receive Discord attachments as multimodal input, send screenshots back
- **Token rotation** — Claude 429 / usage exhaustion → automatic multi-account rotation
- **MCP integration** — Memento (persistent memory) + EJClaw host tools (send_message, schedule_task, watch_ci, etc.)
- **Browser automation** — [gstack browse](https://github.com/garrytan/gstack) skill, headless Chromium daemon
- **Priority queue** — Per-group serialization, global concurrency limit
- **Session persistence** — Resume conversations across restarts
- **Scheduled tasks** — Cron/interval/once via MCP tool
- **Mid-turn steering** — Inject follow-up messages while agent is working

## Architecture

```
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Owner (Codex/Claude Code)
                                          │       │
                                          │       ▼ (auto-trigger)
                                          └──► Reviewer (Claude Code/Codex)
                                          │       │
                                          │   Verdict routing
                                          │       ├─ DONE → merge_ready → Owner finalizes
                                          │       ├─ BLOCKED/NEEDS_CONTEXT → User
                                          │       └─ Feedback → Owner (loop)
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
- Discord bot tokens (3: Claude, Codex-main, Codex-review)

### Install

```bash
git clone https://github.com/phj1081/EJClaw.git
cd EJClaw
npm install
npm run build:runners
npm run build
```

### Environment

All configuration in a single `.env` file:

```bash
# Discord bots (3 tokens for 3 bots)
DISCORD_BOT_TOKEN=               # Claude bot
DISCORD_CODEX_BOT_TOKEN=         # Codex-main bot (owner)
DISCORD_REVIEW_BOT_TOKEN=        # Codex-review bot (fallback reviewer)

# Agent type configuration
OWNER_AGENT_TYPE=codex            # codex | claude-code
REVIEWER_AGENT_TYPE=claude-code   # claude-code | codex

# API keys
CLAUDE_CODE_OAUTH_TOKEN=          # Claude Code OAuth token
CLAUDE_CODE_OAUTH_TOKENS=         # Comma-separated tokens for multi-account rotation
OPENAI_API_KEY=                   # For Codex
GROQ_API_KEY=                     # Voice transcription (Groq Whisper)

# Bot names
ASSISTANT_NAME=claude             # Claude bot trigger name
CODEX_ASSISTANT_NAME=codex        # Codex bot trigger name
```

### Authentication

Multi-account OAuth token rotation is supported via `CLAUDE_CODE_OAUTH_TOKENS` (comma-separated). When one account hits a rate limit, the system automatically rotates to the next.

Token auto-refresh runs on the Claude service only, refreshing access tokens 30 minutes before expiry using rotating refresh tokens from `~/.claude/.credentials.json` (account 0) and `~/.claude-accounts/{n}/.credentials.json` (account 1+). Generate tokens with `claude setup-token` (account 0) or `CLAUDE_CONFIG_DIR=~/.claude-accounts/{n} claude setup-token` (account 1+).

### Systemd Service (Linux)

Single unified service:

```bash
systemctl --user restart ejclaw    # Restart
systemctl --user status ejclaw     # Check status
systemctl --user enable ejclaw     # Enable on boot
journalctl --user -u ejclaw -f     # Follow logs
```

### Deploy

Build on server, not locally:

```bash
ssh clone-ej@100.64.185.108 'cd ~/EJClaw && git pull && npm run build && npm run build:runners && systemctl --user restart ejclaw'
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
