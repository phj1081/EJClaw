import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConversationWorkspaceManager,
  conversationLockKey,
  conversationWorkspacePath,
} from "../src/conversation-workspace";
import type { JobRecord, RouteConfig } from "../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): { root: string; route: RouteConfig } {
  const root = join(tmpdir(), `conversation-workspace-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  git(root, "init");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "README.md"), "baseline\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "baseline");
  roots.push(root);
  return {
    root,
    route: {
      id: "eyejokerdb-dev",
      discordChannelId: "base-channel",
      cwd: root,
      lockKey: "eyejokerdb-dev",
      model: "claude-fable-5",
      effort: "high",
      permissionMode: "bypassPermissions",
      requireMention: false,
      conversationWorktrees: true,
      worktreeRef: "HEAD",
    },
  };
}

function job(conversationKey: string, threadId: string): JobRecord {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    routeId: "eyejokerdb-dev",
    lockKey: conversationKey,
    conversationKey,
    channelId: threadId,
    threadId,
    messageId: crypto.randomUUID(),
    authorId: "owner",
    prompt: "task",
    rawPrompt: false,
    attachmentPaths: [],
    status: "running",
    sessionId: crypto.randomUUID(),
    pinnedSession: false,
    githubWatchRepo: null,
    githubWatchNumber: null,
    expectedHeadSha: null,
    attempts: 1,
    startedBefore: false,
    recoveryReason: null,
    continuationPrompt: null,
    continuationSessionId: null,
    continuationTurn: 0,
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
    createdAt: timestamp,
    startedAt: timestamp,
    heartbeatAt: timestamp,
    completedAt: null,
  };
}

describe("conversation workspaces", () => {
  test("uses a stable per-conversation lock while preserving a shared-lock opt out", () => {
    const { route } = fixture();
    expect(conversationLockKey(route, "eyejokerdb-dev:thread-a")).toBe("eyejokerdb-dev:thread-a");
    expect(conversationLockKey({ ...route, conversationWorktrees: false }, "eyejokerdb-dev:thread-a")).toBe(
      "eyejokerdb-dev",
    );
  });

  test("prepares distinct real git worktrees for distinct Discord threads and reuses them", async () => {
    const { root, route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const manager = new ConversationWorkspaceManager(workspaceRoot);
    const firstJob = job("eyejokerdb-dev:thread-a", "thread-a");
    const secondJob = job("eyejokerdb-dev:thread-b", "thread-b");

    const [first, second] = await Promise.all([
      manager.prepare(route, firstJob),
      manager.prepare(route, secondJob),
    ]);
    const reused = await manager.prepare(route, firstJob);

    expect(first.cwd).toBe(conversationWorkspacePath(workspaceRoot, join(root, ".git"), route.id, "thread-a"));
    expect(second.cwd).toBe(conversationWorkspacePath(workspaceRoot, join(root, ".git"), route.id, "thread-b"));
    expect(first.cwd).not.toBe(second.cwd);
    expect(reused.cwd).toBe(first.cwd);
    expect(git(first.cwd, "rev-parse", "--git-common-dir")).toContain(join(root, ".git"));
    expect(git(second.cwd, "status", "--porcelain")).toBe("");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  test("resolves HEAD and configured refs from the route worktree", async () => {
    const { root, route } = fixture();
    const routeWorktree = join(tmpdir(), `route-worktree-${crypto.randomUUID()}`);
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(routeWorktree, workspaceRoot);
    git(root, "worktree", "add", "--detach", routeWorktree, "HEAD");
    writeFileSync(join(routeWorktree, "README.md"), "route head\n");
    git(routeWorktree, "add", "README.md");
    git(routeWorktree, "commit", "-m", "route head");
    const routeHead = git(routeWorktree, "rev-parse", "HEAD");

    writeFileSync(join(root, "README.md"), "primary head\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "primary head");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(routeHead);

    const manager = new ConversationWorkspaceManager(workspaceRoot);
    const prepared = await manager.prepare(
      { ...route, cwd: routeWorktree, worktreeRef: "HEAD" },
      job("eyejokerdb-dev:route-head", "route-head"),
    );
    expect(git(prepared.cwd, "rev-parse", "HEAD")).toBe(routeHead);
  });

  test("rejects a pre-created symlink at the deterministic workspace path", async () => {
    const { root, route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const expected = conversationWorkspacePath(workspaceRoot, join(root, ".git"), route.id, "thread-symlink");
    mkdirSync(join(expected, ".."), { recursive: true });
    symlinkSync(root, expected, "dir");

    const manager = new ConversationWorkspaceManager(workspaceRoot);
    await expect(manager.prepare(route, job("eyejokerdb-dev:thread-symlink", "thread-symlink"))).rejects.toThrow(
      "symlink",
    );
  });

  test("restores the exact clean reachable revision after cleanup", async () => {
    const { route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const manager = new ConversationWorkspaceManager(workspaceRoot);
    const currentJob = job("eyejokerdb-dev:thread-revision", "thread-revision");
    const prepared = await manager.prepare(route, currentJob);
    git(prepared.cwd, "switch", "-c", "conversation-feature");
    writeFileSync(join(prepared.cwd, "README.md"), "conversation revision\n");
    git(prepared.cwd, "add", "README.md");
    git(prepared.cwd, "commit", "-m", "conversation revision");
    const revision = git(prepared.cwd, "rev-parse", "HEAD");
    const old = new Date(Date.now() - 60_000);
    utimesSync(prepared.cwd, old, old);

    const cleanup = await manager.cleanup({ ttlMs: 1, nowMs: Date.now() });
    expect(cleanup.removed).toEqual([prepared.cwd]);
    expect(existsSync(prepared.cwd)).toBe(false);

    const recreated = await manager.prepare(route, currentJob);
    expect(git(recreated.cwd, "rev-parse", "HEAD")).toBe(revision);
    expect(Bun.file(join(recreated.cwd, "README.md")).text()).resolves.toBe("conversation revision\n");
  });

  test("restores a source session revision into a distinct branch workspace and rejects dirty fork capture", async () => {
    const { route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const manager = new ConversationWorkspaceManager(workspaceRoot);
    const branchJob = job("eyejokerdb-dev:branch-thread", "branch-thread");
    const prepared = await manager.prepare(route, branchJob);
    const sourceRevision = git(prepared.cwd, "rev-parse", "HEAD");

    git(prepared.cwd, "checkout", "-b", "fork-change");
    writeFileSync(join(prepared.cwd, "fork-only.txt"), "fork branch\n");
    git(prepared.cwd, "add", "fork-only.txt");
    git(prepared.cwd, "commit", "-m", "fork change");

    const restored = await manager.prepare(route, branchJob, undefined, {
      identity: `${branchJob.threadId}:session:source-session`,
      baseRef: sourceRevision,
    });
    expect(restored.cwd).not.toBe(prepared.cwd);
    expect(git(restored.cwd, "rev-parse", "HEAD")).toBe(sourceRevision);
    expect(existsSync(join(restored.cwd, "fork-only.txt"))).toBe(false);

    writeFileSync(join(restored.cwd, "dirty.txt"), "dirty\n");
    await expect(manager.captureCleanRevision(route, restored.cwd)).rejects.toThrow(/dirty/);
  });

  test("removes only expired clean reachable worktrees and protects active paths", async () => {
    const { route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const manager = new ConversationWorkspaceManager(workspaceRoot);
    const first = await manager.prepare(route, job("eyejokerdb-dev:cleanup-a", "cleanup-a"));
    const second = await manager.prepare(route, job("eyejokerdb-dev:cleanup-b", "cleanup-b"));
    const old = new Date(1_000);
    utimesSync(first.cwd, old, old);
    utimesSync(second.cwd, old, old);

    const lifecycle: string[] = [];
    const cleanup = await manager.cleanup({
      protectedPaths: [second.cwd],
      ttlMs: 1,
      nowMs: Date.now(),
      beforeRemove: (path) => {
        lifecycle.push(`before:${path}:${existsSync(path)}`);
      },
      afterRemove: (path) => {
        lifecycle.push(`after:${path}:${existsSync(path)}`);
      },
    });

    expect(cleanup.removed).toEqual([first.cwd]);
    expect(lifecycle).toEqual([`before:${first.cwd}:true`, `after:${first.cwd}:false`]);
    expect(cleanup.skipped).toContainEqual({ path: second.cwd, reason: "active job protects workspace" });
    expect(existsSync(first.cwd)).toBe(false);
    expect(existsSync(second.cwd)).toBe(true);
  });

  test("recovers a tombstoned cleanup interrupted before Git removal", async () => {
    const { route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const manager = new ConversationWorkspaceManager(workspaceRoot);
    const prepared = await manager.prepare(route, job("eyejokerdb-dev:cleanup-crash", "cleanup-crash"));
    const old = new Date(Date.now() - 10_000);
    utimesSync(prepared.cwd, old, old);

    const interrupted = await manager.cleanup({
      ttlMs: 1,
      nowMs: Date.now(),
      beforeRemove: () => {
        throw new Error("simulated crash after durable tombstone");
      },
    });
    expect(interrupted.removed).toEqual([]);
    expect(interrupted.skipped).toContainEqual({
      path: prepared.cwd,
      reason: "simulated crash after durable tombstone",
    });
    expect(existsSync(prepared.cwd)).toBe(true);

    await manager.recoverPendingCleanup(prepared.cwd);
    expect(existsSync(prepared.cwd)).toBe(false);
  });

  test("serializes cleanup with prepare and refuses a workspace touched after its scan", async () => {
    const { root, route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const manager = new ConversationWorkspaceManager(workspaceRoot);
    const prepared = await manager.prepare(route, job("eyejokerdb-dev:cleanup-race", "cleanup-race"));
    const old = new Date(1_000);
    utimesSync(prepared.cwd, old, old);

    const internal = manager as unknown as {
      repositoryQueue: {
        run<T>(key: string, task: () => Promise<T> | T): Promise<T>;
      };
    };
    const originalRun = internal.repositoryQueue.run.bind(internal.repositoryQueue);
    let cleanupQueueKey = "";
    internal.repositoryQueue.run = async <T>(key: string, task: () => Promise<T> | T): Promise<T> => {
      cleanupQueueKey = key;
      const touched = new Date();
      utimesSync(prepared.cwd, touched, touched);
      return originalRun(key, task);
    };

    const cleanup = await manager.cleanup({ ttlMs: 1, nowMs: Date.now() });
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.skipped).toContainEqual({
      path: prepared.cwd,
      reason: "workspace was touched after cleanup scan",
    });
    expect(cleanupQueueKey).toBe(join(root, ".git"));
    expect(existsSync(prepared.cwd)).toBe(true);
  });

  test("skips dirty worktrees and frees quota through safe cleanup", async () => {
    const { route } = fixture();
    const workspaceRoot = join(tmpdir(), `managed-conversation-workspaces-${crypto.randomUUID()}`);
    roots.push(workspaceRoot);
    const manager = new ConversationWorkspaceManager(workspaceRoot, 120_000, {
      maxTotal: 2,
      maxPerRepository: 2,
    });
    const first = await manager.prepare(route, job("eyejokerdb-dev:quota-a", "quota-a"));
    const dirty = await manager.prepare(route, job("eyejokerdb-dev:quota-b", "quota-b"));
    writeFileSync(join(dirty.cwd, "UNTRACKED.txt"), "keep me\n");
    await expect(manager.prepare(route, job("eyejokerdb-dev:quota-c", "quota-c"))).rejects.toThrow("quota");

    const old = new Date(1_000);
    utimesSync(first.cwd, old, old);
    utimesSync(dirty.cwd, old, old);
    const cleanup = await manager.cleanup({ ttlMs: 1, nowMs: Date.now(), maxTotal: 2, maxPerRepository: 2 });
    expect(cleanup.removed).toEqual([first.cwd]);
    expect(cleanup.skipped.find((entry) => entry.path === dirty.cwd)?.reason).toContain("dirty");

    const third = await manager.prepare(route, job("eyejokerdb-dev:quota-c", "quota-c"));
    expect(existsSync(third.cwd)).toBe(true);
  });
});
