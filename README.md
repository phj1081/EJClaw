# EJClaw

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.87-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.117.0-green)
![Bun](https://img.shields.io/badge/Bun-1.3+-f9f1e1?logo=bun&logoColor=black)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

Tribunal multi-agent AI assistant (Owner + Reviewer + Arbiter) over Discord with autonomous paired review and Mixture of Agents.

Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).
Prompt design inspired by [Q00/ouroboros](https://github.com/Q00/ouroboros) and [garrytan/gstack](https://github.com/garrytan/gstack).

## Overview

A single unified service (`ejclaw`) runs a **Tribunal** of three roles:

| Role | Purpose |
|------|---------|
| **Owner** | Handles user requests, writes code |
| **Reviewer** | Critically reviews owner's work, verifies design direction |
| **Arbiter** | On-demand deadlock breaker between owner and reviewer |

Each role's agent type and model are independently configurable via `.env` (`OWNER_AGENT_TYPE`, `REVIEWER_AGENT_TYPE`, `ARBITER_AGENT_TYPE`, `*_MODEL`). Three Discord bots provide the identity layer — which bot speaks is determined by the active role, not hardcoded.

### Tribunal Flow

```
User message
  → Owner responds
    → Reviewer auto-triggered (critical review)
      → DONE → Owner finalizes → @user ✅
      → Feedback → Owner addresses → loop
      → BLOCKED → Arbiter (if enabled) or @user ⚠️
      → Deadlock (3+ rounds) → Arbiter summoned → binding verdict
```

### Mixture of Agents (MoA)

When enabled, the arbiter collects opinions from configurable external reference models before rendering its verdict. No extra SDK processes — lightweight API calls only.

## Features

- **Tribunal 3-agent system** — Owner/reviewer/arbiter with on-demand deadlock resolution
- **Per-role model selection** — `OWNER_MODEL`, `REVIEWER_MODEL`, `ARBITER_MODEL` + effort + fallback
- **Container-isolated reviewer** — Docker container with read-only source mount (supports both Claude and Codex runners)
- **Global failover** — Claude exhaustion → automatic codex fallback, auto-recovers
- **Mixture of Agents** — External reference models enrich arbiter verdicts
- **Token rotation** — Multi-account Claude/Codex rotation on rate limits
- **Voice transcription** — Groq/OpenAI Whisper
- **Session persistence** — Separate sessions per role
- **Mid-turn steering** — Inject follow-up messages while agent is working

## Quick Start

```bash
git clone https://github.com/phj1081/EJClaw.git
cd EJClaw
bun install
bun run build:runners    # Build both runners
bun run build            # Build main project
bun run build:container  # Build reviewer Docker image
cp .env.example .env     # Configure tokens and settings
bun run deploy           # Or: bun run dev
```

## Documentation

- [Architecture](docs/architecture.md) — Data flow, room model, container isolation, key files
- [Configuration](docs/configuration.md) — Full `.env` reference, debugging paths

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
