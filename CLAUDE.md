# EJClaw

Dual-agent AI assistant (Claude Code + Codex) over Discord. Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Quick Context

Single unified service (`ejclaw`) manages three Discord bots (Claude, Codex-main, Codex-review) in one process. Owner/reviewer agent types are configurable via `OWNER_AGENT_TYPE` and `REVIEWER_AGENT_TYPE` in `.env`. Claude Code uses the Agent SDK; Codex uses the Codex SDK (`codex exec`). Auth via `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (1-year token from `claude setup-token`).

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
| `/update-ejclaw` | Bring upstream EJClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run build                              # Build main project
npm run build:runners                      # Install + build both runners
npm run dev                                # Dev mode with hot reload
```

Service management (Linux):
```bash
systemctl --user restart ejclaw                   # Restart unified service
systemctl --user status ejclaw                    # Check status
journalctl --user -u ejclaw -f                    # Follow logs
```

Deploy to server (build on server, not locally):
```bash
ssh clone-ej@100.64.185.108 'cd ~/EJClaw && git pull && npm run build && npm run build:runners && systemctl --user restart ejclaw'
```

## Service Stack Architecture

Single unified service manages all three Discord bots in one process:
- `ejclaw.service` — Unified process, `UNIFIED_MODE=true` (default)
- Discord bots: `DISCORD_BOT_TOKEN` (Claude), `DISCORD_CODEX_BOT_TOKEN` (Codex-main), `DISCORD_REVIEW_BOT_TOKEN` (Codex-review)
- Paired review: owner (`OWNER_AGENT_TYPE`, default: codex) ↔ reviewer (`REVIEWER_AGENT_TYPE`, default: claude-code)
- Reviewer fallback: Claude 429/한도초과 시 codex-review로 자동 핸드오프
- Shared dirs: `store/`, `groups/`, `data/`
- SQLite WAL mode + `busy_timeout=5000` for concurrent access

## Debugging Paths (Server: clone-ej@100.64.185.108)

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
