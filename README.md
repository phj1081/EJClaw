# EJClaw

![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.81-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.115.0-green)
![Bun](https://img.shields.io/badge/Bun-1.3+-f9f1e1?logo=bun&logoColor=black)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

Tribunal multi-agent AI assistant (Claude Code + Codex + Arbiter) over Discord with autonomous paired review and Mixture of Agents.

Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), now maintained as EJClaw for personal production use.
Prompt design inspired by [Q00/ouroboros](https://github.com/Q00/ouroboros) and [garrytan/gstack](https://github.com/garrytan/gstack), adapted for EJClaw's Discord and dual-service workflow.
Tribunal arbiter system inspired by multi-agent consensus architectures.

## Overview

A single unified service (`ejclaw`) manages three Discord bots in one process:

- **Codex-main** (`@codex`) — Owner agent. Handles user requests, writes code.
- **Claude** (`@claude`) — Reviewer agent. Critically reviews owner's work, verifies design direction.
- **Codex-review** (`@codex-review`) — Arbiter agent. Summoned on-demand to break deadlocks between owner and reviewer.

All agent types and models are independently configurable per role via `.env`.

## Tribunal 3-Agent System

```
User message
  → Owner responds (implementation, answer, etc.)
    → Reviewer auto-triggered (critical review, design check)
      → Verdict:
          DONE              → Owner finalizes → Task completed
          DONE_WITH_CONCERNS → Owner addresses feedback → loop
          BLOCKED/NEEDS_CONTEXT
            ├─ Arbiter enabled → Arbiter judges → PROCEED/REVISE/RESET/ESCALATE
            └─ Arbiter disabled → Escalate to user
      → Deadlock (3+ round trips without progress)
          → Arbiter summoned → binding verdict → loop resumes
```

### Mixture of Agents (MoA)

When enabled, the arbiter collects opinions from external models (Kimi, GLM, etc.) before rendering its verdict:

```
Deadlock detected → MoA reference queries (Kimi + GLM, parallel)
  → Opinions injected into arbiter's prompt
    → SDK arbiter (subscription-based) aggregates all perspectives
      → Final verdict: PROCEED / REVISE / RESET / ESCALATE
```

No extra SDK processes. External references use lightweight API calls (Anthropic-compatible).

## Features

- **Tribunal 3-agent system** — Owner/reviewer/arbiter with on-demand deadlock resolution
- **Mixture of Agents** — External model opinions (Kimi, GLM) enrich arbiter verdicts
- **Per-role model selection** — `OWNER_MODEL`, `REVIEWER_MODEL`, `ARBITER_MODEL` + effort + fallback toggle
- **Container-isolated reviewer** — Persistent Docker container with read-only source mount
- **Global failover** — Account-level Claude failure → all channels switch to codex, auto-recovers
- **Post-approval change detection** — Re-triggers review if owner modifies code after approval
- **Voice transcription** — Groq Whisper (primary) / OpenAI Whisper (fallback)
- **Token rotation** — Multi-account Claude/Codex rotation on rate limits
- **Kimi usage dashboard** — Coding plan 5h/7d usage displayed alongside Claude/Codex
- **MCP integration** — Memento (persistent memory) + EJClaw host tools
- **Session persistence** — Separate sessions per role (owner/reviewer/arbiter)
- **Scheduled tasks** — Cron/interval/once via MCP tool
- **Mid-turn steering** — Inject follow-up messages while agent is working
- **Bun runtime** — Native SQLite (bun:sqlite), fast startup, no native addon builds

## Architecture

```
Discord ──► SQLite (WAL) ──► GroupQueue ──┬──► Owner (host process)
                                          │       │
                                          │       ▼ (auto-trigger)
                                          ├──► Reviewer (Docker container, :ro mount)
                                          │       │
                                          │   Verdict routing
                                          │       ├─ DONE → change detection → finalize or re-review
                                          │       ├─ BLOCKED → Arbiter (if enabled) or User
                                          │       └─ Feedback → Owner (loop)
                                          │
                                          ├──► Arbiter (on-demand, fresh session each time)
                                          │       │
                                          │   ┌───┴─── MoA (if enabled) ───┐
                                          │   │ Kimi API ──► opinion       │
                                          │   │ GLM API  ──► opinion       │
                                          │   │ → injected into prompt     │
                                          │   └────────────────────────────┘
                                          │       │
                                          │   PROCEED/REVISE/RESET/ESCALATE
                                          │
                                     IPC polling ◄── follow-up messages
                                          │
                                     Router ──► Discord (text, images, files)
```

## Setup

### Prerequisites

- Linux (Ubuntu 22.04+) or macOS
- [Bun](https://bun.sh/) 1.3+
- Docker (required for reviewer container isolation)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)
- Discord bot tokens (3: Claude, Codex-main, Codex-review/Arbiter)

### Install

```bash
git clone https://github.com/phj1081/EJClaw.git
cd EJClaw
bun install
bun run build:runners
bun run build
bun run build:container          # Build reviewer Docker image
```

### Environment

All configuration in a single `.env` file:

```bash
# Discord bots (3 tokens for 3 bots)
DISCORD_BOT_TOKEN=               # Claude bot
DISCORD_CODEX_BOT_TOKEN=         # Codex-main bot (owner)
DISCORD_REVIEW_BOT_TOKEN=        # Codex-review bot (arbiter)

# Agent types
OWNER_AGENT_TYPE=codex            # codex | claude-code
REVIEWER_AGENT_TYPE=claude-code   # claude-code | codex
ARBITER_AGENT_TYPE=codex          # codex | claude-code (optional, enables 3rd agent)

# Per-role model overrides
OWNER_MODEL=gpt-5.4
REVIEWER_MODEL=claude-opus-4-6
ARBITER_MODEL=gpt-5.4

# API keys
CLAUDE_CODE_OAUTH_TOKEN=          # Claude Code OAuth token
CLAUDE_CODE_OAUTH_TOKENS=         # Comma-separated for multi-account rotation
GROQ_API_KEY=                     # Voice transcription (Groq Whisper)

# Mixture of Agents (MoA)
MOA_ENABLED=true
MOA_REF_MODELS=kimi,glm
MOA_KIMI_MODEL=kimi-k2.5
MOA_KIMI_BASE_URL=https://api.kimi.com/coding
MOA_KIMI_API_KEY=sk-kimi-xxx
MOA_KIMI_API_FORMAT=anthropic
MOA_GLM_MODEL=glm-5.1
MOA_GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
MOA_GLM_API_KEY=xxx
MOA_GLM_API_FORMAT=anthropic
```

### Deploy

```bash
cd ~/EJClaw
git pull && bun run build && bun run build:runners && bun run build:container && systemctl --user restart ejclaw
```

## Development

```bash
bun run build                # Build main project
bun run build:runners        # Install + build both runners
bun run build:container      # Rebuild reviewer Docker image
bun run dev                  # Dev mode with hot reload
bun test                     # Run tests
```

## License

MIT — Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
