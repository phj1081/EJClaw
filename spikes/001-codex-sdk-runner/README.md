# 001: codex-sdk-runner

## Question

Given EJClaw currently wraps `codex app-server` JSON-RPC directly, when we switch the runner core to the official `@openai/codex-sdk`, can we preserve the key runner guarantees: thread resume, final result extraction, cancellation, and structured event visibility?

## Approach

- Added `@openai/codex-sdk@0.136.0` beside `@openai/codex@0.136.0` in the codex runner workspace.
- Built a `CodexSdkClient` adapter that maps EJClaw's existing app-server input shape into SDK input.
- Added `CODEX_RUNTIME=sdk` runtime selection while keeping app-server as the default.
- Added `CODEX_RUNTIME_SDK_ROLES=owner,arbiter` canary limiting so production can try SDK only on selected paired roles.
- Fallbacks: `/compact` and `codexGoals` stay on app-server because SDK lacks those APIs.
- Wrote unit tests around SDK event reduction, thread-id propagation, runtime selection, and unsupported steering.
- Ran real smoke turns through both the SDK adapter and the integrated codex-runner entrypoint against temporary git repos.

## Evidence

Commands run:

```bash
bunx vitest run runners/codex-runner/test/sdk-client.test.ts
bunx vitest run runners/codex-runner/test/runtime-mode.test.ts
bunx tsc --noEmit -p runners/codex-runner/tsconfig.json
bun run --cwd runners/codex-runner build
bunx vitest run \
  runners/codex-runner/test/app-server-client.test.ts \
  runners/codex-runner/test/app-server-state.test.ts \
  runners/codex-runner/test/runtime-mode.test.ts \
  runners/codex-runner/test/sdk-client.test.ts
bun run check
CODEX_RUNTIME=sdk CODEX_EFFORT=minimal node runners/codex-runner/dist/index.js < /tmp/input.json
```

Observed adapter smoke result:

```json
{
  "status": "completed",
  "result": "SDK_OK",
  "error": null
}
```

Observed integrated runner smoke result:

```json
{
  "status": "success",
  "result": "SDK_RUNNER_OK",
  "phase": "final",
  "newSessionId": "019e..."
}
```

## What worked

- SDK import and runner workspace build work on Node/Bun in this repo.
- SDK streaming events can be reduced into EJClaw-style `status`, `threadId`, `result`, `error`, and `usage`.
- `thread.started` gives the real thread id during the first streamed turn, so a pending local handle can be replaced with the real session id.
- `AbortController` gives a clean replacement for close-sentinel cancellation.
- Real SDK smoke and integrated runner smoke completed successfully.
- Runtime flag selection works: default app-server; `CODEX_RUNTIME=sdk` selects SDK; `CODEX_RUNTIME_SDK_ROLES` canaries SDK to chosen paired roles; `/compact` and goals fall back to app-server.

## What did not work / gaps

- SDK does **not** expose app-server `turn/steer`; mid-turn Discord follow-up steering would need to be queued for the next turn or stay on the app-server path.
- SDK TypeScript wrapper uses `codex exec --experimental-json`, not persistent `codex app-server`, so process-per-turn overhead and session behavior must be measured under real long tasks.
- Passing `modelReasoningEffort: "minimal"` failed in live smoke because Codex exec still enabled tools that are incompatible with minimal reasoning. The spike adapter coerces `minimal` to `low`.
- Existing Codex app-server-only features (`thread/goal/*`, `thread/compact/start`) are not available through the current SDK API.

## Verdict: FEATURE-FLAGGED

SDK is now viable as an optional **exec-backed Codex runner lane** behind `CODEX_RUNTIME=sdk`. The default remains app-server, and `CODEX_RUNTIME_SDK_ROLES=owner,arbiter` can limit SDK to safer paired roles while reviewer/non-paired turns keep the old path.

## Recommended rollout

1. Merge as a draft/feature-flagged implementation without changing production env.
2. Enable `CODEX_RUNTIME=sdk` for one low-risk owner/arbiter lane first.
3. Keep app-server mode for rooms/tasks that require live steering, goals, or compaction.
4. Watch `turn.failed`, `error`, `item.completed:error`, empty final output, and process-per-turn latency before promoting SDK broadly.
