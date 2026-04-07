# EJClaw

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.87-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.117.0-green)
![Bun](https://img.shields.io/badge/Bun-1.3+-f9f1e1?logo=bun&logoColor=black)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

Tribunal multi-agent AI assistant (Owner + Reviewer + Arbiter) over Discord with autonomous paired review and Mixture of Agents.

## Overview

A single unified service (`ejclaw`) runs a **Tribunal** of three roles while
managing three Discord bots in one process:

| Role | Purpose |
|------|---------|
| **Owner** | Handles user requests, writes code |
| **Reviewer** | Critically reviews owner's work, verifies design direction |
| **Arbiter** | On-demand deadlock breaker between owner and reviewer |

The identity layer is role-fixed:

- **Owner bot** — Handles the owner turn output slot.
- **Reviewer bot** — Handles the reviewer turn output slot.
- **Arbiter bot** — Handles the arbiter turn output slot.

Each role's agent type and model are independently configurable via `.env`
(`OWNER_AGENT_TYPE`, `REVIEWER_AGENT_TYPE`, `ARBITER_AGENT_TYPE`, `*_MODEL`).
Three Discord bots provide the identity layer — which bot speaks is determined
by the active role, not hardcoded.

## Room Assignment Model

Per-room routing now uses an explicit assignment model:

- `room_settings` is the room-level source of truth (SSOT)
- Each room stores:
  - `room_mode`: `single` or `tribunal`
  - `owner_agent_type`: `codex` or `claude-code`
- Public room assignment uses `assign_room`
- Legacy `register_group` public interfaces were removed
- `registered_groups` remains as a materialized capability/read-model layer and legacy fallback, not the authoritative room configuration

Operationally:

- `single` → one owner bot
- `tribunal` → per-room owner + globally configured reviewer + optional arbiter

This means tribunal is no longer inferred from “two bots registered on one room”; it is an explicit room setting.

## Tribunal Flow

```
User message
  → Owner responds (implementation, answer, etc.)
    → Reviewer auto-triggered (critical review, design check)
      → Verdict:
          DONE              → Owner finalizes → Task completed → @user ✅
          DONE_WITH_CONCERNS → Owner addresses feedback → loop
          BLOCKED/NEEDS_CONTEXT
            ├─ Arbiter enabled → Arbiter judges → PROCEED/REVISE/RESET/ESCALATE
            └─ Arbiter disabled → Escalate to user → @user ⚠️
      → Owner BLOCKED/NEEDS_CONTEXT → Arbiter (same path as reviewer)
      → Deadlock (2+ round trips without progress)
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
- **Discord-independent communication** — Agent-to-agent data flows directly via DB, Discord is display-only
- **Mixture of Agents** — External model opinions (Kimi, GLM) enrich arbiter verdicts
- **Per-role model selection** — `OWNER_MODEL`, `REVIEWER_MODEL`, `ARBITER_MODEL` + effort + fallback toggle
- **Host reviewer with read-only guards** — Reviewer runs on host with role-scoped sandbox and guard policy
- **Global failover** — Account-level Claude failure → all channels switch to codex, auto-recovers
- **Post-approval change detection** — Re-triggers review if owner modifies code after approval
- **Auto user notification** — @mention on task completion (✅ done, ⚠️ escalated)
- **Loop protection** — Deadlock threshold, merge_ready oscillation guard, arbiter re-invocation limit
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
                                          ├──► Reviewer (host process, read-only guarded)
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
                              ┌────────── Router ──────────┐
                              ▼                            ▼
                   paired_turn_outputs           Discord (display only)
                   (agent ↔ agent data)      (user observation, @mention)
```

## Setup

### Prerequisites

- Linux (Ubuntu 22.04+) or macOS
- [Bun](https://bun.sh/) 1.3+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)
- Discord bot tokens (3: owner, reviewer, arbiter)

### Install

```bash
git clone https://github.com/phj1081/EJClaw.git
cd EJClaw
bun install
bun run build:runners
bun run build
```

## Documentation

- [Architecture](docs/architecture.md) — Data flow, room model, verification execution, key files
- [Configuration](docs/configuration.md) — Full `.env` reference, debugging paths

### Deploy

```bash
bun run deploy
```

## Development

```bash
bun run build                # Build main project
bun run build:runners        # Install + build both runners
bun run dev                  # Dev mode with hot reload
bun test                     # Run tests
```

## Acknowledgments

- Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
- Prompt design inspired by [Q00/ouroboros](https://github.com/Q00/ouroboros) and [garrytan/gstack](https://github.com/garrytan/gstack)

## License

MIT
