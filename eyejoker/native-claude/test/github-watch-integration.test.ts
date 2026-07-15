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
    store.close();

    const run = () => spawnSync("/home/ejclaw/.bun/bin/bun", ["run", "src/github-watch.ts"], {
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
});
