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
  const calls: Array<{
    resume: boolean;
    prompt: string;
    sessionId: string;
    forkSession: boolean | undefined;
    continuationTurn: number | undefined;
  }> = [];
  const executor: ClaudeExecutor = async (request) => {
    calls.push({
      resume: request.resume,
      prompt: request.prompt,
      sessionId: request.sessionId,
      forkSession: request.forkSession,
      continuationTurn: request.continuationTurn,
    });
    const next = executions.shift();
    if (!next) throw new Error("no fake execution");
    request.onSessionEstablished?.(next.sessionId);
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
  test("passes raw Claude slash commands without wrapping them in /goal", async () => {
    const env = setup([ok("raw-session", "compacted")]);
    env.store.enqueue({
      routeId: route.id,
      conversationKey: `${route.id}:raw-thread`,
      channelId: "raw-thread",
      threadId: "raw-thread",
      messageId: "raw-command",
      authorId: "owner",
      prompt: "/compact",
      attachmentPaths: [],
      rawPrompt: true,
    });
    await env.runtime.runUntilIdle();
    expect(env.calls[0]?.prompt).toBe("/compact");
  });

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

  test("hands the managed workspace to an explicit SDK fork and detaches the source branch path", async () => {
    const store = freshStore();
    const managedPath = "/tmp/managed-explicit-fork";
    const managedRoute = { ...route, cwd: managedPath, conversationWorktrees: true };
    const original = enqueue(store, "explicit-fork");
    store.setSessionWorkspace(original.conversationKey, managedPath);
    store.setSessionBranchRevision(
      original.conversationKey,
      original.sessionId,
      "4444444444444444444444444444444444444444",
    );
    store.markSessionHistory(original.conversationKey);
    store.requestFork(original.conversationKey);
    const forkedSessionId = crypto.randomUUID();
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, managedRoute]]),
      executor: async (request) => {
        expect(request.forkSession).toBe(true);
        request.onSessionEstablished?.(forkedSessionId);
        return ok(forkedSessionId);
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 1,
    });

    await runtime.runUntilIdle();
    expect(store.sessionBranchForSession(original.conversationKey, original.sessionId)).toMatchObject({
      workspacePath: null,
      workspaceRevision: "4444444444444444444444444444444444444444",
    });
    expect(store.sessionBranchForSession(original.conversationKey, forkedSessionId)).toMatchObject({
      workspacePath: managedPath,
      status: "active",
    });
  });

  test("keeps an explicit fork reserved across pre-init failure and acknowledges only the child init", async () => {
    const store = freshStore();
    const managedPath = "/tmp/managed-explicit-fork-retry";
    const managedRoute = { ...route, cwd: managedPath, conversationWorktrees: true };
    const original = enqueue(store, "explicit-fork-retry");
    store.setSessionWorkspace(original.conversationKey, managedPath);
    store.setSessionBranchRevision(
      original.conversationKey,
      original.sessionId,
      "5555555555555555555555555555555555555555",
    );
    store.markSessionHistory(original.conversationKey);
    store.requestFork(original.conversationKey);
    const childSessionId = crypto.randomUUID();
    const forks: Array<boolean | undefined> = [];
    let attempt = 0;
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, managedRoute]]),
      executor: async (request) => {
        attempt += 1;
        forks.push(request.forkSession);
        expect(store.forkRequested(original.conversationKey)).toBe(true);
        if (attempt === 1) {
          return {
            ok: false,
            result: "pre-init timeout",
            sessionId: request.sessionId,
            stderr: "timeout",
            exitCode: 124,
          };
        }
        request.onSessionEstablished?.(childSessionId);
        expect(store.forkRequested(original.conversationKey)).toBe(false);
        return ok(childSessionId);
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 2,
    });

    await runtime.runUntilIdle();
    expect(forks).toEqual([true, true]);
    expect(store.forkRequested(original.conversationKey)).toBe(false);
    expect(store.sessionBranchForSession(original.conversationKey, original.sessionId)).toMatchObject({
      workspacePath: null,
      workspaceRevision: "5555555555555555555555555555555555555555",
    });
    expect(store.sessionBranchForSession(original.conversationKey, childSessionId)).toMatchObject({
      workspacePath: managedPath,
      status: "active",
    });
  });

  test("forks an existing session once when moving it into a conversation worktree", async () => {
    const store = freshStore();
    const seen: Array<{ cwd: string; resume: boolean; forkSession: boolean | undefined }> = [];
    const movedRoute = { ...route, conversationWorktrees: true };
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, movedRoute]]),
      prepareRoute: async (baseRoute) => ({ ...baseRoute, cwd: "/tmp/conversation-worktree" }),
      executor: async (request) => {
        seen.push({ cwd: request.route.cwd, resume: request.resume, forkSession: request.forkSession });
        return ok(request.sessionId);
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 1,
    });

    const first = enqueue(store, "workspace-first");
    store.setSessionWorkspace(first.conversationKey, "/tmp/original-checkout");
    store.markSessionHistory(first.conversationKey);
    await runtime.runUntilIdle();
    enqueue(store, "workspace-second");
    await runtime.runUntilIdle();

    expect(seen).toEqual([
      { cwd: "/tmp/conversation-worktree", resume: true, forkSession: true },
      { cwd: "/tmp/conversation-worktree", resume: true, forkSession: false },
    ]);
    expect(store.sessionWorkspace(first.conversationKey)).toBe("/tmp/conversation-worktree");
  });

  test("forks after a tombstoned workspace is recreated at the same deterministic path", async () => {
    const store = freshStore();
    const deterministicPath = "/tmp/conversation-worktree";
    const seen: Array<{ cwd: string; resume: boolean; forkSession: boolean | undefined }> = [];
    const movedRoute = { ...route, conversationWorktrees: true };
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, movedRoute]]),
      prepareRoute: async (baseRoute) => ({ ...baseRoute, cwd: deterministicPath }),
      executor: async (request) => {
        seen.push({ cwd: request.route.cwd, resume: request.resume, forkSession: request.forkSession });
        request.onSessionEstablished?.("recreated-session");
        return ok("recreated-session");
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 1,
    });

    const queued = enqueue(store, "workspace-recreated");
    store.setSessionWorkspace(queued.conversationKey, deterministicPath);
    store.markSessionHistory(queued.conversationKey);
    store.beginWorkspaceCleanup(deterministicPath, "1111111111111111111111111111111111111111");
    store.finishWorkspaceCleanup(deterministicPath);
    expect(store.sessionWorkspace(queued.conversationKey)).toBeNull();

    await runtime.runUntilIdle();
    expect(seen).toEqual([{ cwd: deterministicPath, resume: true, forkSession: true }]);
    expect(store.sessionWorkspace(queued.conversationKey)).toBe(deterministicPath);
  });

  test("keeps workspace migration pending until a forked SDK session is established", async () => {
    const store = freshStore();
    const forks: Array<boolean | undefined> = [];
    let attempt = 0;
    const movedRoute = { ...route, conversationWorktrees: true };
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, movedRoute]]),
      prepareRoute: async (baseRoute) => ({ ...baseRoute, cwd: "/tmp/conversation-worktree" }),
      executor: async (request) => {
        attempt += 1;
        forks.push(request.forkSession);
        if (attempt === 1) {
          return { ok: false, result: "pre-init timeout", sessionId: request.sessionId, stderr: "timeout", exitCode: 124 };
        }
        request.onSessionEstablished?.("forked-session");
        return ok("forked-session");
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 2,
    });

    const first = enqueue(store, "workspace-init-failure");
    store.setSessionWorkspace(first.conversationKey, "/tmp/original-checkout");
    store.markSessionHistory(first.conversationKey);
    await runtime.runUntilIdle();

    expect(forks).toEqual([true, true]);
    expect(store.sessionWorkspace(first.conversationKey)).toBe("/tmp/conversation-worktree");
    expect(store.listSessionBranches(first.conversationKey).find((branch) => branch.status === "active")).toMatchObject({
      sessionId: "forked-session",
      workspacePath: "/tmp/conversation-worktree",
    });
  });

  test("forks a pinned legacy session when its workspace moves", async () => {
    const store = freshStore();
    const movedRoute = { ...route, conversationWorktrees: true };
    const original = enqueue(store, "pinned-origin");
    store.setSessionWorkspace(original.conversationKey, "/tmp/original-checkout");
    store.markSessionHistory(original.conversationKey);
    store.cancelJob(original.id, "seed only");
    let seenFork: boolean | undefined;
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, movedRoute]]),
      prepareRoute: async (baseRoute) => ({ ...baseRoute, cwd: "/tmp/conversation-worktree" }),
      executor: async (request) => {
        seenFork = request.forkSession;
        request.onSessionEstablished?.("pinned-fork");
        return ok("pinned-fork");
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 1,
    });
    store.enqueue({
      routeId: route.id,
      conversationKey: original.conversationKey,
      channelId: "thread",
      threadId: "thread",
      messageId: "pinned-wake",
      authorId: "owner",
      prompt: "watcher wake",
      attachmentPaths: [],
      sessionId: original.sessionId,
      pinnedSession: true,
    });

    await runtime.runUntilIdle();

    expect(seenFork).toBe(true);
    expect(store.sessionWorkspace(original.conversationKey)).toBe("/tmp/original-checkout");
    expect(store.getByMessageId("pinned-wake")).toMatchObject({
      sessionId: "pinned-fork",
      workspacePath: "/tmp/conversation-worktree",
    });
    expect(store.listSessionBranches(original.conversationKey).find((branch) => branch.sessionId === "pinned-fork")).toMatchObject({
      status: "archived",
      workspacePath: "/tmp/conversation-worktree",
    });
  });

  test("does not fork a legacy shared-checkout session only because workspace metadata is absent", async () => {
    const store = freshStore();
    const seen: Array<{ resume: boolean; forkSession: boolean | undefined }> = [];
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, route]]),
      executor: async (request) => {
        seen.push({ resume: request.resume, forkSession: request.forkSession });
        return ok(request.sessionId);
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 1,
    });

    const job = enqueue(store, "legacy-shared-workspace");
    store.markSessionHistory(job.conversationKey);
    await runtime.runUntilIdle();

    expect(seen).toEqual([{ resume: true, forkSession: false }]);
    expect(store.sessionWorkspace(job.conversationKey)).toBe(route.cwd);
  });

  test("startup recovery resumes the interrupted session and preserves the original request", async () => {
    const env = setup([
      { ok: true, result: "recovered", sessionId: "session-a", stderr: "", exitCode: 0 },
    ]);
    const job = enqueue(env.store, "m1");
    env.store.claimNext(1);
    env.store.beginSteeringInput({
      messageId: "pending-followup",
      jobId: job.id,
      conversationKey: job.conversationKey,
      content: "재시작 경계 추가 지시",
      sdkMessageId: crypto.randomUUID(),
    });
    env.store.recoverInterrupted("service restart");
    await env.runtime.runUntilIdle();
    expect(env.calls[0]?.resume).toBe(true);
    expect(env.calls[0]?.sessionId).toBe(job.sessionId);
    expect(env.calls[0]?.prompt).toContain("task-m1");
    expect(env.calls[0]?.prompt).toContain("service restart");
    expect(env.calls[0]?.prompt).toContain("재시작 경계 추가 지시");
    expect(env.calls[0]?.prompt).toContain("중복 실행하지 마");
    expect(env.store.getSteeringInput("pending-followup")?.state).toBe("accepted");
  });

  test("startup recovery resumes the exact persisted marker continuation instead of the original task", async () => {
    const env = setup([ok("marker-session", "continued")]);
    const job = enqueue(env.store, "marker-recovery");
    env.store.claimNext(1);
    env.store.stageContinuation(job.id, "[Discord 질문 답변]\n사용자 선택: 배포", "marker-session", 2);
    env.store.recoverInterrupted("service restart");

    await env.runtime.runUntilIdle();

    expect(env.calls[0]).toMatchObject({
      resume: true,
      sessionId: "marker-session",
      prompt: "[Discord 질문 답변]\n사용자 선택: 배포",
      continuationTurn: 2,
    });
    expect(env.store.getJob(job.id)?.continuationPrompt).toBeNull();
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

  test("cancels a stale watcher job before Claude execution", async () => {
    const store = freshStore();
    let executions = 0;
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, route]]),
      executor: async (request) => {
        executions += 1;
        return ok(request.sessionId);
      },
      preflight: async (job) => ({
        ok: false,
        reason: `head changed from ${job.expectedHeadSha} to new-head`,
      }),
      onFinal: async () => {},
      maxConcurrent: 1,
      maxAttempts: 2,
    });
    const queued = store.enqueue({
      routeId: route.id,
      conversationKey: `${route.id}:watcher-thread`,
      channelId: "watcher-thread",
      threadId: "watcher-thread",
      messageId: "stale-watch",
      authorId: "owner",
      prompt: "fix old head",
      attachmentPaths: [],
      githubWatchRepo: "owner/repo",
      githubWatchNumber: 9,
      expectedHeadSha: "old-head",
    });

    await runtime.runUntilIdle();

    expect(executions).toBe(0);
    expect(store.getJob(queued.id)?.status).toBe("cancelled");
    expect(store.getJob(queued.id)?.error).toContain("head changed");
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
      request.onSessionEstablished?.(request.sessionId);
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
