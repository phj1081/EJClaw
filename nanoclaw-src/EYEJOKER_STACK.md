# Eyejoker NanoClaw stack

This checkout is a thin local carry layer on NanoClaw upstream.

- Upstream base: `ef220b53` (`main`, MIT)
- Discord adapter: applied from upstream's `channels` branch via the bundled `add-discord` skill
- `gpt-proxy` provider: reuses the Claude Agent SDK harness while injecting the private CLIProxyAPI Anthropic-compatible endpoint for GPT/Codex rooms
- Default EYEJOKER group: direct Claude subscription through OneCLI to `api.anthropic.com`
- GPT group: `gpt-proxy` → OneCLI → CLIProxyAPI → Codex OAuth pool

External runtime components are intentionally not vendored:

- CLIProxyAPI: `~/cliproxyapi`, bound only to Docker bridge `172.17.0.1:8317`
- ECC generated profile: `~/ecc-poc/.claude`; projection helper: `~/ecc-poc/sync-to-nanoclaw.sh`
- Host Executor: `~/nanoclaw-host-executor`; runtime socket and audit log under `~/.local/share/nanoclaw-host-executor`
- OneCLI: `~/.onecli`

Secrets stay in ignored/local files (`.env`, `~/.cli-proxy-api`, OneCLI vault). Never commit them.

## Verification

```bash
pnpm run build
pnpm exec vitest run src/channels/discord-registration.test.ts
cd container/agent-runner && bunx tsc --noEmit
```

Runtime probes exercised direct fable, proxied GPT, Discord channel delivery, Discord per-thread delivery, persistent session continuation, ECC observation capture, scheduled-task execution, and Host Executor MCP/audit logging.
