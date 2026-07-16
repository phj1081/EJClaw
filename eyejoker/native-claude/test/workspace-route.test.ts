import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationWorkspaceManager } from "../src/conversation-workspace";
import { JobRuntime } from "../src/runtime";
import { StateStore } from "../src/store";
import type { ClaudeExecution, RouteConfig } from "../src/types";
import { prepareConversationRoute } from "../src/workspace-route";

const roots: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function execution(sessionId: string, result: string): ClaudeExecution {
  return { ok: true, result, sessionId, stderr: "", exitCode: 0 };
}

describe("conversation workspace branch routing", () => {
  test("restores the source SDK branch into a distinct Git tree after an explicit fork", async () => {
    const root = join(tmpdir(), `workspace-route-repo-${crypto.randomUUID()}`);
    const workspaceRoot = join(tmpdir(), `workspace-route-managed-${crypto.randomUUID()}`);
    const dbPath = join(tmpdir(), `workspace-route-${crypto.randomUUID()}.sqlite`);
    roots.push(root, workspaceRoot, dbPath);
    mkdirSync(root, { recursive: true });
    git(root, "init");
    git(root, "config", "user.name", "Native Test");
    git(root, "config", "user.email", "native@example.com");
    writeFileSync(join(root, "README.md"), "source branch\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "initial");

    const route: RouteConfig = {
      id: "route-a",
      discordChannelId: "channel-a",
      cwd: root,
      model: "claude-fable-5",
      effort: "high",
      permissionMode: "bypassPermissions",
      requireMention: false,
      conversationWorktrees: true,
      worktreeRef: "HEAD",
    };
    const store = new StateStore(dbPath);
    stores.push(store);
    const workspaceManager = new ConversationWorkspaceManager(workspaceRoot);
    const sourceSessionId = crypto.randomUUID();
    const forkSessionId = crypto.randomUUID();
    const restoredSessionId = crypto.randomUUID();
    const paths: string[] = [];
    let executionIndex = 0;
    const runtime = new JobRuntime({
      store,
      routes: new Map([[route.id, route]]),
      prepareRoute: (baseRoute, job) =>
        prepareConversationRoute({
          route: baseRoute,
          job,
          store,
          workspaceManager,
          cleanup: async () => undefined,
        }),
      executor: async (request) => {
        paths.push(request.route.cwd);
        if (executionIndex === 0) {
          expect(request.forkSession).toBe(false);
          request.onSessionEstablished?.(sourceSessionId);
          executionIndex += 1;
          return execution(sourceSessionId, "source ready");
        }
        if (executionIndex === 1) {
          expect(request.forkSession).toBe(true);
          request.onSessionEstablished?.(forkSessionId);
          writeFileSync(join(request.route.cwd, "fork-only.txt"), "fork branch\n");
          git(request.route.cwd, "add", "fork-only.txt");
          git(request.route.cwd, "commit", "-m", "fork-only change");
          executionIndex += 1;
          return execution(forkSessionId, "fork changed");
        }
        expect(request.forkSession).toBe(true);
        expect(existsSync(join(request.route.cwd, "fork-only.txt"))).toBe(false);
        request.onSessionEstablished?.(restoredSessionId);
        executionIndex += 1;
        return execution(restoredSessionId, "source restored");
      },
      onFinal: async () => undefined,
      maxConcurrent: 1,
      maxAttempts: 1,
    });
    const enqueue = (messageId: string) =>
      store.enqueue({
        routeId: route.id,
        conversationKey: `${route.id}:thread-a`,
        channelId: "thread-a",
        threadId: "thread-a",
        messageId,
        authorId: "owner",
        prompt: messageId,
        attachmentPaths: [],
      });

    enqueue("source-turn");
    await runtime.runUntilIdle();
    store.requestFork(`${route.id}:thread-a`);
    enqueue("fork-turn");
    await runtime.runUntilIdle();

    const sourceAfterFork = store.sessionBranchForSession(`${route.id}:thread-a`, sourceSessionId);
    expect(sourceAfterFork?.workspacePath).toBeNull();
    expect(sourceAfterFork?.workspaceRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(store.sessionBranchForSession(`${route.id}:thread-a`, forkSessionId)?.workspacePath).toBe(paths[1]);
    expect(store.useSessionBranch(`${route.id}:thread-a`, sourceSessionId).sessionId).toBe(sourceSessionId);

    enqueue("restore-source-turn");
    await runtime.runUntilIdle();

    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(paths[1]);
    expect(paths[2]).not.toBe(paths[1]);
    expect(existsSync(join(paths[1]!, "fork-only.txt"))).toBe(true);
    expect(existsSync(join(paths[2]!, "fork-only.txt"))).toBe(false);
    expect(store.sessionWorkspace(`${route.id}:thread-a`)).toBe(paths[2]!);
    expect(store.listActive()).toHaveLength(0);
  });
});
