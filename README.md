<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Dual-agent AI assistant running Claude Code + Codex as parallel services over Discord.
</p>

<p align="center">
  Based on <a href="https://github.com/qwibitai/nanoclaw">qwibitai/nanoclaw</a>
</p>

## Overview

Two AI agents running as parallel systemd services, communicating over Discord:

- **Claude Code** — powered by Claude Agent SDK, trigger `@claude`
- **Codex** — powered by Codex app-server (JSON-RPC), trigger `@codex`

Each agent has its own store, data, and groups directories. Discord channels can be registered with either agent, or both (`both` agent type for shared channels).

### Key Features

- **Direct host processes** — no container overhead, agents run natively
- **Bidirectional image support** — receive images as multimodal input, send as Discord attachments
- **Skill sync** — single source of truth (`~/.claude/skills/`), auto-synced to all sessions
- **OAuth auto-refresh** — token lifecycle managed automatically for headless environments
- **Priority queue** — per-group serialization, global concurrency limit, idle preemption
- **Auto-continue** — Codex text-only turns automatically retried to enforce task execution

## Architecture

```
Discord ──► SQLite ──► GroupQueue ──┬──► Claude Agent SDK (host process)
                                    └──► Codex App-Server (JSON-RPC stdio)
                                              ├── thread/start, thread/resume
                                              ├── turn/start (streaming, multimodal)
                                              ├── turn/steer (mid-turn injection)
                                              ├── Auto-approval (bypass sandbox)
                                              └── Auto-continue (text-only turn retry)
```

### Directory Layout

```
nanoclaw/
├── src/
│   ├── index.ts                # Orchestrator: state, message loop, agent invocation
│   ├── agent-runner.ts         # Spawns agent processes, manages env/sessions/skills
│   ├── group-queue.ts          # Per-group concurrency, priority queue, idle preemption
│   ├── group-folder.ts         # Group directory resolution and management
│   ├── router.ts               # Outbound message formatting and routing
│   ├── sender-allowlist.ts     # Security: sender-based access control
│   ├── session-commands.ts     # Session commands (/compact)
│   ├── token-refresh.ts        # OAuth auto-refresh + session directory sync
│   ├── task-scheduler.ts       # Scheduled tasks (cron/interval/once)
│   ├── ipc.ts                  # IPC watcher and task processing
│   ├── db.ts                   # SQLite operations
│   ├── config.ts               # Paths, intervals, trigger patterns
│   └── channels/
│       ├── registry.ts         # Channel self-registration system
│       └── discord.ts          # Discord: mentions, images, typing, file attachments
├── container/
│   ├── agent-runner/           # Claude Code runner (Agent SDK, multimodal input)
│   ├── codex-runner/           # Codex runner (app-server JSON-RPC, auto-continue)
│   └── skills/                 # Shared agent skills (browser, etc.)
├── store/                      # Claude Code service DB
├── store-codex/                # Codex service DB
├── data/
│   ├── sessions/               # Per-group Claude sessions (.claude/)
│   └── attachments/            # Downloaded Discord image attachments
├── data-codex/sessions/        # Per-group Codex sessions (.codex/)
├── groups/                     # Per-group memory and workspace (Claude Code)
├── groups-codex/               # Per-group memory and workspace (Codex)
└── logs/                       # Service logs
```

### Codex App-Server Integration

The Codex runner (`container/codex-runner/`) communicates with `codex app-server` via JSON-RPC over stdio:

- **Session persistence**: Thread IDs stored in DB, sessions saved as JSONL on disk
- **Streaming**: `item/agentMessage/delta` notifications for real-time text
- **Mid-turn steering**: IPC messages injected via `turn/steer` during execution
- **Auto-approval**: `approvalPolicy: "never"` + `sandbox: "danger-full-access"`
- **Auto-continue**: Detects text-only turns (no tool execution) and automatically retries up to 5 times to nudge the agent into actually executing tasks
- **Multimodal input**: Image attachments converted to `localImage` input blocks in `turn/start`
- **Per-group config**: Model, effort, MCP servers configured per channel

### Image Handling

Bidirectional image support through Discord:

- **Receiving** (user → agent): Discord image attachments are downloaded to `data/attachments/`, then passed as base64 `ImageBlockParam` content blocks (Claude Code) or `localImage` input blocks (Codex)
- **Sending** (agent → user): Markdown image links `[name.png](/path)` in agent responses are automatically parsed and sent as Discord file attachments. Non-image file links are converted to readable filenames (`BuildPanel.tsx:320`)

### Skill Sync

Skills are managed from a single source of truth (`~/.claude/skills/` on the server) and automatically synced to all agent session directories at process start:

- Claude Code sessions: `~/.claude/skills/` + project `container/skills/`
- Codex sessions: Same sources, synced to per-group `.codex/` directories
- Skills auto-register as slash commands (`/name`) in Claude Code and `$name` in Codex

### OAuth Token Auto-Refresh

`src/token-refresh.ts` handles Claude Code OAuth token lifecycle:

- Checks every 5 minutes, refreshes 30 minutes before expiry
- Tries `platform.claude.com` then falls back to `api.anthropic.com`
- Syncs refreshed credentials to all per-group session directories
- Solves the known headless environment token expiry issue

### GroupQueue

`src/group-queue.ts` manages agent execution with:

- **Per-group serialization**: Only one agent process per group at a time
- **Global concurrency limit**: Configurable max concurrent agents across all groups
- **Task priority**: Scheduled tasks drain before message processing
- **Idle preemption**: Idle agents are terminated when higher-priority tasks arrive
- **Exponential backoff**: Retries with backoff on processing failure

## Setup

### Prerequisites

- Linux (Ubuntu 22.04+) or macOS
- Node.js 20+
- [Claude Code CLI](https://claude.ai/download)
- [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)

### Environment Variables

```bash
# .env
DISCORD_BOT_TOKEN=           # Claude Code bot token
DISCORD_CODEX_BOT_TOKEN=     # Codex bot token (optional, for dual-bot)
ANTHROPIC_API_KEY=            # Or use OAuth (CLAUDE_CODE_OAUTH_TOKEN)
OPENAI_API_KEY=               # For Codex
CODEX_MODEL=                  # Default codex model
CODEX_EFFORT=                 # Default reasoning effort (low/medium/high)
```

### Service Management (Linux)

```bash
systemctl --user start nanoclaw           # Claude Code service
systemctl --user start nanoclaw-codex     # Codex service
systemctl --user restart nanoclaw nanoclaw-codex  # Restart both
journalctl --user -u nanoclaw -f          # Follow logs
```

### Service Management (macOS)

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw-codex.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Channel Registration

Channels are registered in each service's SQLite database (`registered_groups` table). Each entry specifies:

- **jid**: Discord channel ID (`dc:<channel_id>`)
- **folder**: Group folder name (matches Discord channel name)
- **trigger_pattern**: Regex for bot activation (`@claude` or `@codex`)
- **agent_type**: `claude-code`, `codex`, or `both` (shared channel)
- **work_dir**: Working directory for the agent
- **container_config**: JSON config (e.g., `{"codexEffort":"high"}`)

## Development

```bash
npm run build                              # Build main project
cd container/agent-runner && npm run build # Build Claude runner
cd container/codex-runner && npm run build # Build Codex runner
npm run dev                                # Dev mode with hot reload
npm test                                   # Run tests
```

## License

MIT — Based on [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
