# Architecture

## Service Stack

Single unified service (`ejclaw`) manages all three Discord bots in one process:

- `ejclaw.service` — Single unified process
- Discord bots: `DISCORD_BOT_TOKEN` (Claude), `DISCORD_CODEX_BOT_TOKEN` (Codex-main), `DISCORD_REVIEW_BOT_TOKEN` (Codex-review)
- Paired review: owner ↔ reviewer (agent types configurable per role)
- Reviewer fallback: Claude exhaustion → codex-review auto-handoff
- Shared dirs: `store/`, `groups/`, `data/`
- SQLite WAL mode + `busy_timeout=5000` for concurrent access

## Data Flow

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
                                          │   │ Ref model A ──► opinion    │
                                          │   │ Ref model B ──► opinion    │
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

## Room Assignment Model

Per-room routing uses an explicit assignment model:

- `room_settings` is the room-level source of truth (SSOT)
- Each room stores:
  - `room_mode`: `single` or `tribunal`
  - `owner_agent_type`: `codex` or `claude-code`
- Public room assignment uses `assign_room`
- `registered_groups` remains as a materialized capability/read-model layer

Operationally:

- `single` → one owner bot
- `tribunal` → per-room owner + globally configured reviewer + optional arbiter

Tribunal is no longer inferred from "two bots registered on one room"; it is an explicit room setting.

## Tribunal 3-Agent System

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
      → Deadlock (3+ round trips without progress)
          → Arbiter summoned → binding verdict → loop resumes
```

## Container Isolation

Reviewer and arbiter run inside a Docker container with:

- Read-only source mount (kernel-level write protection)
- Both Claude (agent-runner) and Codex (codex-runner) supported
- Runner selected at `docker exec` time based on agent type
- tmpfs overlays for test runner caches
- IPC via filesystem for follow-up messages
- Credentials injected per-exec (never baked into container)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent-runner.ts` | Spawns agent processes, manages env/sessions/skills |
| `src/container-runner.ts` | Docker container execution for reviewer/arbiter |
| `src/channels/discord.ts` | Discord channel (8s typing refresh, Whisper transcription) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `runners/agent-runner/` | Claude Code runner (Agent SDK) |
| `runners/codex-runner/` | Codex runner (SDK, `codex exec` wrapper) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
