# 001: codex-sdk-runner

## Question

Given EJClaw currently wraps `codex app-server` JSON-RPC directly, when we switch the runner core to the official `@openai/codex-sdk`, can we preserve the key runner guarantees: thread resume, final result extraction, cancellation, and structured event visibility?

## Approach

- Added `@openai/codex-sdk@0.136.0` beside `@openai/codex@0.136.0` in the codex runner workspace.
- Built a throwaway `CodexSdkClient` adapter that maps EJClaw's existing app-server input shape into SDK input.
- Wrote unit tests around SDK event reduction and thread-id propagation.
- Ran a real smoke turn through the SDK against a temporary git repo.

## Evidence

Commands run:

```bash
bunx vitest run runners/codex-runner/test/sdk-client.test.ts
bunx tsc --noEmit -p runners/codex-runner/tsconfig.json
bun run --cwd runners/codex-runner build
bunx vitest run \
  runners/codex-runner/test/app-server-client.test.ts \
  runners/codex-runner/test/app-server-state.test.ts \
  runners/codex-runner/test/sdk-client.test.ts
node /tmp/codex-sdk-smoke-*/smoke.mjs
```

Observed smoke result:

```json
{
  "status": "completed",
  "result": "SDK_OK",
  "error": null
}
```

## What worked

- SDK import and runner workspace build work on Node/Bun in this repo.
- SDK streaming events can be reduced into EJClaw-style `status`, `threadId`, `result`, `error`, and `usage`.
- `thread.started` gives the real thread id during the first streamed turn, so a pending local handle can be replaced with the real session id.
- `AbortController` gives a clean replacement for close-sentinel cancellation.
- Real SDK smoke completed successfully.

## What did not work / gaps

- SDK does **not** expose app-server `turn/steer`; mid-turn Discord follow-up steering would need to be queued for the next turn or stay on the app-server path.
- SDK TypeScript wrapper uses `codex exec --experimental-json`, not persistent `codex app-server`, so process-per-turn overhead and session behavior must be measured under real long tasks.
- Passing `modelReasoningEffort: "minimal"` failed in live smoke because Codex exec still enabled tools that are incompatible with minimal reasoning. The spike adapter coerces `minimal` to `low`.
- Existing Codex app-server-only features (`thread/goal/*`, `thread/compact/start`) are not available through the current SDK API.

## Verdict: PARTIAL

SDK is viable for a **new Codex exec-backed runner lane** and likely gives cleaner event semantics than our raw app-server JSON-RPC wrapper. It is not a drop-in replacement for all current app-server features because steering, goals, and compaction are missing.

## Recommendation for real build

1. Add SDK mode behind an env flag, e.g. `CODEX_RUNTIME=sdk`, not as an immediate hard replacement.
2. Use SDK mode first for owner/arbiter turns where mid-turn steering is less important.
3. Keep app-server mode for rooms/tasks that require live steering, goals, or compaction.
4. Add raw SDK event logging around `turn.failed`, `error`, `item.completed:error`, and empty `finalResponse` before promoting SDK mode broadly.
5. Measure one real EJClaw long task with SDK mode before merging it into the service default.
