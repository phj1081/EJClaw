# EJClaw

Dual-agent AI assistant (Claude Code + Codex) over Discord. Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Quick Context

Single unified service (`ejclaw`) manages three Discord bots (owner, reviewer, arbiter) in one process. Agent types behind each role remain configurable via `OWNER_AGENT_TYPE`, `REVIEWER_AGENT_TYPE`, and `ARBITER_AGENT_TYPE` in `.env`. Claude Code uses the Agent SDK; Codex uses the Codex SDK (`codex exec`). Auth via `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (1-year token from `claude setup-token`).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent-runner.ts` | Spawns agent processes, manages env/sessions/skills |
| `src/channels/discord.ts` | Discord channel (8s typing refresh, Groq/OpenAI Whisper transcription) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `runners/agent-runner/` | Claude Code runner (Agent SDK) |
| `runners/codex-runner/` | Codex runner (SDK, `codex exec` wrapper) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Agent issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
bun run build                              # Build main project
bun run build:runners                      # Install + build both runners
bun run build:runtime                      # Build host runtime only
bun run dev                                # Dev mode with hot reload
```

Service management (Linux):
```bash
systemctl --user restart ejclaw                   # Restart unified service
systemctl --user status ejclaw                    # Check status
journalctl --user -u ejclaw -f                    # Follow logs
```

Deploy:
```bash
bun run deploy
```

`deploy` rebuilds only the host runtime, and verification also runs directly on
the host runtime.

## Service Stack Architecture

Single unified service manages all three Discord bots in one process:
- `ejclaw.service` — Single unified process
- Discord bots: `DISCORD_OWNER_BOT_TOKEN` (owner), `DISCORD_REVIEWER_BOT_TOKEN` (reviewer), `DISCORD_ARBITER_BOT_TOKEN` (arbiter)
- Old service-based token names are no longer accepted; migrate them to the canonical role-based keys above before starting the service
- Paired review: owner (`OWNER_AGENT_TYPE`, default: codex) ↔ reviewer (`REVIEWER_AGENT_TYPE`, default: claude-code)
- Provider fallback is internal routing only — visible Discord bots stay owner/reviewer/arbiter fixed
- Shared dirs: `store/`, `groups/`, `data/`
- SQLite WAL mode + `busy_timeout=5000` for concurrent access

## Debugging Paths

Unified DB + directories (both services share `store/`, `groups/`, `data/`):

| 항목 | 경로 |
|------|------|
| **DB** | `store/messages.db` (공유, WAL 모드) |
| 서비스 로그 | `journalctl --user -u ejclaw -f` 또는 `logs/ejclaw.log` |
| 그룹별 로그 | `groups/{name}/logs/` (공유 채널은 양쪽 봇 로그가 같은 폴더) |
| Claude 세션 | `data/sessions/{name}/.claude/` |
| Codex 세션 | `data/sessions/{name}/.codex/` |
| Claude 플랫폼 규칙 | `prompts/claude-platform.md` |
| Codex 플랫폼 규칙 | `prompts/codex-platform.md` |
| Claude 글로벌 메모리 | `groups/global/CLAUDE.md` |

## Codex SDK

Codex runner uses `@openai/codex-sdk` (wraps `codex exec`):
- `codex.startThread()` / `codex.resumeThread()` for session persistence
- `thread.run(input)` for single-shot turn execution (completes all work before returning)
- `approvalPolicy: "never"` + `sandboxMode: "danger-full-access"` for bypass
- Per-group: model (`CODEX_MODEL`), effort (`CODEX_EFFORT`), MCP servers via `config.toml`
- `CODEX_HOME` set to per-group session dir, reads `AGENTS.md` from there + CWD

## Voice Transcription

Audio attachments in Discord are transcribed via Groq Whisper (primary) or OpenAI Whisper (fallback):
- `GROQ_API_KEY` — Groq `whisper-large-v3-turbo`, ~200x real-time, free tier (console.groq.com)
- `OPENAI_API_KEY` — OpenAI `whisper-1`, fallback if Groq key not set
- Shared file cache (`cache/transcriptions/`) deduplicates across both services
- `.pending` file coordination prevents duplicate API calls
