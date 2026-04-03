# Configuration

All configuration in a single `.env` file.

## Discord Bots

```bash
DISCORD_BOT_TOKEN=               # Claude bot
DISCORD_CODEX_BOT_TOKEN=         # Codex-main bot (owner)
DISCORD_REVIEW_BOT_TOKEN=        # Codex-review bot (arbiter)
```

## Agent Types & Models

```bash
# Agent types per role
OWNER_AGENT_TYPE=codex            # codex | claude-code
REVIEWER_AGENT_TYPE=claude-code   # claude-code | codex
ARBITER_AGENT_TYPE=codex          # codex | claude-code (optional, enables 3rd agent)

# Per-role model overrides
OWNER_MODEL=gpt-5.4
REVIEWER_MODEL=claude-opus-4-6
ARBITER_MODEL=gpt-5.4

# Per-role effort level
OWNER_EFFORT=xhigh
REVIEWER_EFFORT=high
ARBITER_EFFORT=xhigh

# Per-role fallback toggle
REVIEWER_FALLBACK_ENABLED=true    # Auto-handoff to codex when Claude exhausted
ARBITER_FALLBACK_ENABLED=false

# Response language
AGENT_LANGUAGE=Korean             # Injected into all agent prompts
```

## Authentication

```bash
CLAUDE_CODE_OAUTH_TOKEN=          # Claude Code OAuth token
CLAUDE_CODE_OAUTH_TOKENS=         # Comma-separated for multi-account rotation
OPENAI_API_KEY=                   # Codex API key (if not using OAuth)
```

## Voice Transcription

```bash
GROQ_API_KEY=                     # Groq whisper-large-v3-turbo (primary)
OPENAI_API_KEY=                   # OpenAI whisper-1 (fallback)
```

## Mixture of Agents (MoA)

```bash
MOA_ENABLED=true
MOA_REF_MODELS=kimi,glm           # Configurable reference model list

# Per-model config (pattern: MOA_{NAME}_{SETTING})
MOA_KIMI_MODEL=kimi-k2.5
MOA_KIMI_BASE_URL=https://api.kimi.com/coding
MOA_KIMI_API_KEY=sk-kimi-xxx
MOA_KIMI_API_FORMAT=anthropic

MOA_GLM_MODEL=glm-5.1
MOA_GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
MOA_GLM_API_KEY=xxx
MOA_GLM_API_FORMAT=anthropic
```

## Debugging Paths

| Item | Path |
|------|------|
| **DB** | `store/messages.db` (shared, WAL mode) |
| Service log | `journalctl --user -u ejclaw -f` or `logs/ejclaw.log` |
| Per-group logs | `groups/{name}/logs/` |
| Claude sessions | `data/sessions/{name}/.claude/` |
| Codex sessions | `data/sessions/{name}/.codex/` |
| Claude platform rules | `prompts/claude-platform.md` |
| Codex platform rules | `prompts/codex-platform.md` |
| Global memory | `groups/global/CLAUDE.md` |
