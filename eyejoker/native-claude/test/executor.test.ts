import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeProcessExecutor } from "../src/executor";
import type { ExecutionRequest, RouteConfig } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const route: RouteConfig = {
  id: "test",
  discordChannelId: "1",
  cwd: "/tmp",
  model: "claude-fable-5",
  effort: "high",
  permissionMode: "bypassPermissions",
  requireMention: false,
};

function request(resume = false): ExecutionRequest {
  return {
    job: {
      id: "job-1",
      routeId: "test",
      lockKey: "test",
      conversationKey: "test:thread",
      channelId: "thread",
      threadId: "thread",
      messageId: "message",
      authorId: "owner",
      prompt: "task",
      attachmentPaths: [],
      status: "running",
      sessionId: "11111111-1111-4111-8111-111111111111",
      attempts: 1,
      startedBefore: resume,
      recoveryReason: null,
      pid: null,
      result: null,
      error: null,
      finalStatus: null,
      deliveryAttempts: 0,
      deliveryAfter: null,
      deliveryError: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      heartbeatAt: null,
      completedAt: null,
    },
    route,
    prompt: "hello",
    sessionId: "11111111-1111-4111-8111-111111111111",
    resume,
  };
}

function fakeClaude(scriptBody: string): string {
  const root = join(tmpdir(), `native-executor-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "claude");
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${scriptBody}\n`);
  chmodSync(path, 0o755);
  roots.push(root);
  return path;
}

describe("Claude process executor", () => {
  test("runs the native CLI and parses its result", async () => {
    const binary = fakeClaude(
      `printf '%s\\n' '{"type":"result","subtype":"success","result":"OK","session_id":"11111111-1111-4111-8111-111111111111","is_error":false}'`,
    );
    let pid = 0;
    const executor = new ClaudeProcessExecutor({ binary, timeoutSeconds: 10 });
    const execution = await executor.run({ ...request(), onSpawn: (value) => (pid = value) });
    expect(pid).toBeGreaterThan(0);
    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("OK");
  });

  test("escalates cancellation to SIGKILL when Claude ignores SIGTERM", async () => {
    const binary = fakeClaude(`trap '' TERM\nsleep 30`);
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const executor = new ClaudeProcessExecutor({ binary, timeoutSeconds: 30, killGraceMs: 50 });
    const running = executor.run({ ...request(), onSpawn: () => spawned() });
    await ready;
    await Bun.sleep(100);
    expect(executor.cancel("job-1")).toBe(true);
    const execution = await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancel did not terminate")), 2_000)),
    ]);
    expect(execution.ok).toBe(false);
  });

  test("falls back to session-id when a recovered transcript cannot be resumed", async () => {
    const root = join(tmpdir(), `native-executor-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const count = join(root, "count");
    const binary = join(root, "claude");
    writeFileSync(
      binary,
      `#!/usr/bin/env bash\nset -eu\nif printf '%s\\n' "$@" | grep -q -- --resume; then echo 1 > '${count}'; echo 'No conversation found' >&2; exit 1; fi\necho 2 > '${count}'; printf '%s\\n' '{"type":"result","subtype":"success","result":"RECOVERED","session_id":"11111111-1111-4111-8111-111111111111","is_error":false}'\n`,
    );
    chmodSync(binary, 0o755);
    roots.push(root);
    const executor = new ClaudeProcessExecutor({ binary, timeoutSeconds: 10 });
    const execution = await executor.run(request(true));
    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("RECOVERED");
    expect(Bun.file(count).text()).resolves.toBe("2\n");
  });
});
