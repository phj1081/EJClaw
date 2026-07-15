import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/store";
import { JobRuntime } from "../src/runtime";
import type { ClaudeExecution, ClaudeExecutor, RouteConfig } from "../src/types";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

const route: RouteConfig = {
  id: "cleanapo",
  discordChannelId: "100",
  cwd: "/tmp",
  model: "claude-fable-5",
  effort: "high",
  permissionMode: "bypassPermissions",
  requireMention: false,
};

function freshStore(): StateStore {
  const path = join(tmpdir(), `native-runtime-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return new StateStore(path);
}

function ok(sessionId: string, result = "done"): ClaudeExecution {
  return { ok: true, result, sessionId, stderr: "", exitCode: 0 };
}

function setup(executions: ClaudeExecution[]) {
  const store = freshStore();
  const calls: Array<{ resume: boolean; prompt: string; sessionId: string }> = [];
  const executor = async (request: { resume: boolean; prompt: string; sessionId: string }) => {
    calls.push(request);
    const next = executions.shift();
    if (!next) throw new Error("no fake execution");
    return next;
  };
  const delivered: string[] = [];
  const runtime = new JobRuntime({
    store,
    routes: new Map([[route.id, route]]),
    executor,
    onFinal: async (_job, execution) => {
      delivered.push(execution.result);
    },
    maxConcurrent: 1,
    maxAttempts: 2,
  });
  return { store, runtime, calls, delivered };
}

function enqueue(store: StateStore, id: string) {
  return store.enqueue({
    routeId: route.id,
    conversationKey: `${route.id}:thread`,
    channelId: "thread",
    threadId: "thread",
    messageId: id,
    authorId: "owner",
    prompt: `task-${id}`,
    attachmentPaths: [],
  });
}

describe("job runtime", () => {
  test("passes interactive questions through the job-scoped runtime hook", async () => {
    const store = freshStore();
    const seen: string[] = [];
    const executor: ClaudeExecutor = async (request) => {
      const answer = await request.onQuestion?.({ question: "A/B?", choices: ["A", "B"] });
      return ok(request.sessionId, `answer=${answer}`);
    };
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, route]]),
      executor,
      onQuestion: async (job, question) => {
        seen.push(`${job.messageId}:${question.question}`);
        return "B";
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 1,
    });
    enqueue(store, "question-message");
    await runtime.runUntilIdle();
    expect(seen).toEqual(["question-message:A/B?"]);
    expect(store.listJobs()[0]?.result).toBe("answer=B");
  });

  test("first turn creates a session and the next turn resumes it", async () => {
    const env = setup([
      { ok: true, result: "one", sessionId: "session-a", stderr: "", exitCode: 0 },
      { ok: true, result: "two", sessionId: "session-a", stderr: "", exitCode: 0 },
    ]);
    enqueue(env.store, "m1");
    await env.runtime.runUntilIdle();
    enqueue(env.store, "m2");
    await env.runtime.runUntilIdle();
    expect(env.calls.map((x) => x.resume)).toEqual([false, true]);
    expect(env.delivered).toEqual(["one", "two"]);
  });

  test("startup recovery resumes the interrupted session and preserves the original request", async () => {
    const env = setup([
      { ok: true, result: "recovered", sessionId: "session-a", stderr: "", exitCode: 0 },
    ]);
    const job = enqueue(env.store, "m1");
    env.store.claimNext(1);
    env.store.recoverInterrupted("service restart");
    await env.runtime.runUntilIdle();
    expect(env.calls[0]?.resume).toBe(true);
    expect(env.calls[0]?.sessionId).toBe(job.sessionId);
    expect(env.calls[0]?.prompt).toContain("task-m1");
    expect(env.calls[0]?.prompt).toContain("service restart");
  });

  test("cancelled while the start hook is pending never launches Claude", async () => {
    const store = freshStore();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startSeen!: () => void;
    const started = new Promise<void>((resolve) => {
      startSeen = resolve;
    });
    let executions = 0;
    const executor: ClaudeExecutor = async (request) => {
      executions += 1;
      return ok(request.sessionId);
    };
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, route]]),
      executor,
      onStart: async () => {
        startSeen();
        await startGate;
      },
      onFinal: async () => {},
      maxConcurrent: 1,
      maxAttempts: 2,
    });
    const queued = enqueue(store, "cancel-race");
    const pumping = runtime.runUntilIdle();
    await started;
    store.cancelByConversation(queued.conversationKey);
    releaseStart();
    await pumping;
    expect(executions).toBe(0);
    expect(store.getJob(queued.id)?.status).toBe("cancelled");
  });

  test("persists final delivery and model telemetry across retries without rerunning Claude", async () => {
    const store = freshStore();
    let executions = 0;
    let deliveryWorks = false;
    const deliveredModels: Array<{ mainModel: string | null | undefined; subagentModels: string[] | undefined }> = [];
    const executor: ClaudeExecutor = async (request) => {
      executions += 1;
      return {
        ...ok(request.sessionId, "artifact-ready"),
        mainModel: "claude-fable-5",
        subagentModels: ["gpt-5.6-sol"],
      } as ClaudeExecution;
    };
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, route]]),
      executor,
      onFinal: async (_job, execution) => {
        deliveredModels.push({
          mainModel: execution.mainModel,
          subagentModels: execution.subagentModels,
        });
        if (!deliveryWorks) throw new Error("discord unavailable");
      },
      maxConcurrent: 1,
      maxAttempts: 2,
      deliveryRetryMs: 0,
    });
    const queued = enqueue(store, "delivery-retry");
    await runtime.runUntilIdle();
    expect(store.getJob(queued.id)?.status).toBe("delivering");
    deliveryWorks = true;
    await runtime.runUntilIdle();
    expect(store.getJob(queued.id)?.status).toBe("completed");
    expect(executions).toBe(1);
    expect(deliveredModels).toEqual([
      { mainModel: "claude-fable-5", subagentModels: ["gpt-5.6-sol"] },
      { mainModel: "claude-fable-5", subagentModels: ["gpt-5.6-sol"] },
    ]);
  });

  test("a later message resumes a session even when the previous run failed", async () => {
    const store = freshStore();
    const resumeModes: boolean[] = [];
    const executor: ClaudeExecutor = async (request) => {
      resumeModes.push(request.resume);
      return request.job.messageId === "failed-first"
        ? { ok: false, result: "failed", sessionId: request.sessionId, stderr: "", exitCode: 1 }
        : ok(request.sessionId);
    };
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, route]]),
      executor,
      onFinal: async () => {},
      maxConcurrent: 1,
      maxAttempts: 1,
    });
    enqueue(store, "failed-first");
    await runtime.runUntilIdle();
    enqueue(store, "after-failure");
    await runtime.runUntilIdle();
    expect(resumeModes).toEqual([false, true]);
  });

  test("retries a failed execution but stops at the configured bound", async () => {
    const env = setup([
      { ok: false, result: "fail-1", sessionId: "session-a", stderr: "x", exitCode: 1 },
      { ok: false, result: "fail-2", sessionId: "session-a", stderr: "y", exitCode: 1 },
    ]);
    enqueue(env.store, "m1");
    await env.runtime.runUntilIdle();
    expect(env.calls).toHaveLength(2);
    expect(env.store.listJobs()[0]?.status).toBe("failed");
  });
});
