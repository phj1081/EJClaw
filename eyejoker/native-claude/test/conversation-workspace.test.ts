import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
});
