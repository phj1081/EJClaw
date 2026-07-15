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
      deliveryChunks: null,
      deliveryFiles: [],
      deliveryCursor: 0,
      deliveryMessageIds: [],
      progressMessageId: null,
      progressText: null,
      mainModel: null,
      subagentModels: [],
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

  test("keeps the terminal result after bounded stdout diagnostics are full", async () => {
    const binary = fakeClaude(
      [
        `printf '%s\\n' '{"type":"system","subtype":"init","model":"claude-fable-5","session_id":"11111111-1111-4111-8111-111111111111"}'`,
        `python3 -c 'import json; print(json.dumps({"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"x"*4096}]},"session_id":"11111111-1111-4111-8111-111111111111"}))'`,
        `printf '%s\\n' '{"type":"result","subtype":"success","result":"AFTER_CAP_OK","session_id":"11111111-1111-4111-8111-111111111111","is_error":false}'`,
      ].join("\n"),
    );
    const executor = new ClaudeProcessExecutor({ binary, timeoutSeconds: 10, maxOutputBytes: 256 });
    const execution = await executor.run(request());
    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("AFTER_CAP_OK");
    expect(execution.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(execution.mainModel).toBe("claude-fable-5");
  });

  test("keeps stdin open for a Discord question answer before finalizing", async () => {
    const binary = fakeClaude(
      [
        "IFS= read -r initial",
        `printf '%s\\n' '{"type":"result","subtype":"success","result":"DISCORD_QUESTION:{\\"question\\":\\"고를까?\\",\\"choices\\":[\\"A\\",\\"B\\"]}","session_id":"11111111-1111-4111-8111-111111111111","is_error":false}'`,
        "IFS= read -r answer",
        `printf '%s\\n' '{"type":"result","subtype":"success","result":"ANSWERED","session_id":"11111111-1111-4111-8111-111111111111","is_error":false}'`,
      ].join("\n"),
    );
    const questions: string[] = [];
    const executor = new ClaudeProcessExecutor({ binary, timeoutSeconds: 10 });
    const execution = await executor.run({
      ...request(),
      onQuestion: async (question) => {
        questions.push(question.question);
        return "B";
      },
    });
    expect(questions).toEqual(["고를까?"]);
    expect(execution.result).toBe("ANSWERED");
  });

  test("steers a running Claude process through a second user event", async () => {
    const binary = fakeClaude(
      [
        "IFS= read -r initial",
        "IFS= read -r steering",
        `python3 -c 'import json,sys; print(json.dumps({"type":"result","subtype":"success","result":sys.argv[1],"session_id":"11111111-1111-4111-8111-111111111111","is_error":False}))' "$steering"`,
      ].join("\n"),
    );
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => (spawned = resolve));
    const executor = new ClaudeProcessExecutor({ binary, timeoutSeconds: 10 });
    const running = executor.run({ ...request(), onSpawn: spawned });
    await ready;
    expect(executor.steer("job-1", "STEER_NOW")).toBe(true);
    const execution = await running;
    expect(execution.result).toContain("STEER_NOW");
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

  test("emits onProgress events while reading stream-json lines", async () => {
    const binary = fakeClaude(
      [
        `printf '%s\\n' '{"type":"system","subtype":"status","status":"requesting","session_id":"11111111-1111-4111-8111-111111111111"}'`,
        `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}},"session_id":"11111111-1111-4111-8111-111111111111"}'`,
        `printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]},"session_id":"11111111-1111-4111-8111-111111111111"}'`,
        `printf '%s\\n' '{"type":"result","subtype":"success","result":"STREAM_OK","session_id":"11111111-1111-4111-8111-111111111111","is_error":false}'`,
      ].join("\n"),
    );
    const kinds: string[] = [];
    const executor = new ClaudeProcessExecutor({ binary, timeoutSeconds: 10 });
    const execution = await executor.run({
      ...request(),
      onProgress: (event) => {
        kinds.push(event.kind);
      },
    });
    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("STREAM_OK");
    expect(kinds).toContain("status");
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("result");
  });
});
