import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { StateStore } from "../src/store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable GitHub watcher executable", () => {
  test("polls gh and enqueues one same-conversation wake for an actionable signal", () => {
    const root = join(tmpdir(), `github-watch-integration-${crypto.randomUUID()}`);
    const project = join(root, "project");
    const bin = join(root, "bin");
    const dbPath = join(root, "state.sqlite");
    const configPath = join(root, "routes.json");
    mkdirSync(project, { recursive: true });
    mkdirSync(bin, { recursive: true });
    roots.push(root);
    writeFileSync(
      configPath,
      JSON.stringify({
        owner_id: "owner-1",
        max_concurrent: 1,
        routes: [{
          id: "repo",
          discord_channel_id: "channel-1",
          cwd: project,
          model: "claude-fable-5",
          effort: "high",
          permission_mode: "bypassPermissions",
          require_mention: false,
        }],
      }),
    );
    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, `#!/bin/sh\nprintf '%s' '{"state":"OPEN","headRefOid":"abc123","reviewDecision":"","mergeStateStatus":"BLOCKED","comments":[],"reviews":[],"statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE"}]}'\n`);
    chmodSync(fakeGh, 0o700);

    let store = new StateStore(dbPath);
    const origin = store.enqueue({
      routeId: "repo",
      lockKey: project,
      conversationKey: "repo:thread-1",
      channelId: "channel-1",
      threadId: "thread-1",
      messageId: "source-1",
      authorId: "owner-1",
      prompt: "create the PR",
      attachmentPaths: [],
    });
    const watch = store.upsertPullRequestWatch(origin, {
      repo: "owner/repo",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
    });
    expect(watch.sessionId).toBe(origin.sessionId);
    store.resetSession(origin.conversationKey, origin.routeId);
    store.close();

    const run = () => spawnSync(process.execPath, ["run", "src/github-watch.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CLAUDE_NATIVE_CONFIG: configPath,
        CLAUDE_NATIVE_STATE_DB: dbPath,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('"woke":1');

    store = new StateStore(dbPath);
    const afterFirst = store.getPullRequestWatch(watch.id)!;
    expect(afterFirst.wakeCount).toBe(1);
    expect(afterFirst.activeJobId).not.toBeNull();
    const wakeJob = store.getJob(afterFirst.activeJobId!)!;
    expect(wakeJob.conversationKey).toBe(origin.conversationKey);
    expect(wakeJob.sessionId).toBe(origin.sessionId);
    expect(wakeJob.pinnedSession).toBe(true);
    expect(wakeJob.githubWatchRepo).toBe("owner/repo");
    expect(wakeJob.githubWatchNumber).toBe(7);
    expect(wakeJob.expectedHeadSha).toBe("abc123");
    expect(wakeJob.threadId).toBe(origin.threadId);
    expect(wakeJob.prompt).toContain("checks-failed");
    store.close();

    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('"woke":0');
    store = new StateStore(dbPath);
    expect(store.getPullRequestWatch(watch.id)?.wakeCount).toBe(1);
    store.close();
  });

  test("rejects a second conversation trying to reroute an existing PR watch", () => {
    const store = new StateStore(":memory:");
    const enqueue = (conversationKey: string, messageId: string) => store.enqueue({
      routeId: "repo",
      lockKey: "/tmp/repo",
      conversationKey,
      channelId: "channel-1",
      threadId: conversationKey,
      messageId,
      authorId: "owner-1",
      prompt: "watch",
      attachmentPaths: [],
    });
    const reference = { repo: "owner/repo", number: 8, url: "https://github.com/owner/repo/pull/8" };
    const first = enqueue("repo:thread-a", "source-a");
    const second = enqueue("repo:thread-b", "source-b");
    const firstWatch = store.upsertPullRequestWatch(first, reference);
    expect(() => store.upsertPullRequestWatch(second, reference))
      .toThrow("already owned by another session");
    store.completePullRequestWatch(firstWatch.id, "test-complete");
    const transferred = store.upsertPullRequestWatch(second, reference);
    expect(transferred.sessionId).toBe(second.sessionId);
    expect(transferred.conversationKey).toBe(second.conversationKey);
    expect(transferred.wakeCount).toBe(0);
    store.close();
  });

  test("bounds each gh call and exits nonzero when polling fails", () => {
    const root = join(tmpdir(), `github-watch-timeout-${crypto.randomUUID()}`);
    const project = join(root, "project");
    const bin = join(root, "bin");
    const dbPath = join(root, "state.sqlite");
    const configPath = join(root, "routes.json");
    mkdirSync(project, { recursive: true });
    mkdirSync(bin, { recursive: true });
    roots.push(root);
    writeFileSync(configPath, JSON.stringify({
      owner_id: "owner-1",
      routes: [{
        id: "repo", discord_channel_id: "channel-1", cwd: project,
        model: "claude-fable-5", effort: "high", permission_mode: "bypassPermissions", require_mention: false,
      }],
    }));
    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nsleep 2\n");
    chmodSync(fakeGh, 0o700);
    const store = new StateStore(dbPath);
    const origin = store.enqueue({
      routeId: "repo", conversationKey: "repo:timeout", channelId: "channel-1", threadId: "timeout",
      messageId: "source-timeout", authorId: "owner-1", prompt: "watch", attachmentPaths: [],
    });
    store.upsertPullRequestWatch(origin, { repo: "owner/repo", number: 10, url: "https://github.com/owner/repo/pull/10" });
    store.close();

    const started = Date.now();
    const result = spawnSync(process.execPath, ["run", "src/github-watch.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CLAUDE_NATIVE_CONFIG: configPath,
        CLAUDE_NATIVE_STATE_DB: dbPath,
        CLAUDE_NATIVE_GH_TIMEOUT_MS: "100",
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('"errors":1');
  });
});
