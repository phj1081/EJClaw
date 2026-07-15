import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildBubblewrapInvocation,
  buildCohortSandboxEnvironment,
  buildUnixBrokeredBubblewrapInvocation,
} from "../src/cohort-sandbox";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cohort candidate sandbox", () => {
  test("uses an explicit environment allowlist with a non-secret proxy credential", () => {
    const env = buildCohortSandboxEnvironment(
      { sdkVersion: "0.3.210", claudeCodeVersion: "2.1.210" },
      "http://127.0.0.1:43210",
      "ephemeral-test-token",
      "claude-fable-5",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("ephemeral-test-token");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43210");
    expect(env.HOME).toBe("/home/cohort");
    expect(env.PATH).toBe("/sandbox-bin:/usr/local/bin:/usr/bin:/bin");
    expect(env).not.toHaveProperty("DISCORD_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  test("mounts only the candidate worktree writable and hides production HOME", () => {
    const root = join(tmpdir(), `cohort-sandbox-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    const env = buildCohortSandboxEnvironment(
      { sdkVersion: "0.3.210", claudeCodeVersion: "2.1.210" },
      "http://127.0.0.1:43210",
      "ephemeral-test-token",
      "claude-fable-5",
    );
    const invocation = buildBubblewrapInvocation(
      root,
      "/home/ejclaw/.bun/bin/bun",
      ["-e", "console.log(JSON.stringify({home:process.env.HOME,prod:Bun.file('/home/ejclaw/.config/claude-native/env').size>0}))"],
      env,
    );
    expect(invocation.command).toBe("/usr/bin/bwrap");
    const offlineInvocation = buildBubblewrapInvocation(
      root,
      "/home/ejclaw/.bun/bin/bun",
      ["-e", "console.log('offline')"],
      env,
      false,
    );
    expect(offlineInvocation.args).not.toContain("--share-net");
    const renderedArgs = invocation.args.join(" ");
    expect(renderedArgs).not.toContain("--ro-bind /home/ejclaw /home/ejclaw");
    expect(renderedArgs).not.toContain("--bind /home/ejclaw /home/ejclaw");
    expect(renderedArgs).toContain("--ro-bind /run/systemd/resolve /run/systemd/resolve");
    if (process.env.CLAUDE_NATIVE_COHORT_SANDBOX === "1") {
      expect(process.env.HOME).toBe("/home/cohort");
      expect(existsSync("/home/ejclaw/.config/claude-native/env")).toBe(false);
      return;
    }
    const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ home: "/home/cohort", prod: false });
  });

  test("exposes only a Unix broker inside an isolated loopback namespace", async () => {
    const root = join(tmpdir(), `cohort-unix-net-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    const socketPath = join(root, "broker.sock");
    const broker = Bun.serve({
      unix: socketPath,
      fetch() {
        return new Response("UNIX_BROKER_OK");
      },
    });
    const hostLoopback = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("HOST_LOOPBACK_MUST_STAY_HIDDEN");
      },
    });
    try {
      const environment = buildCohortSandboxEnvironment(
        { sdkVersion: "0.3.210", claudeCodeVersion: "2.1.210" },
        "http://127.0.0.1:18765",
        "ephemeral-test-token",
        "claude-fable-5",
      );
      const invocation = buildUnixBrokeredBubblewrapInvocation(
        root,
        process.execPath,
        "/bin/sh",
        [
          "-ceu",
          `test "$(curl -fsS --max-time 2 http://127.0.0.1:18765/)" = UNIX_BROKER_OK; ! curl -fsS --max-time 1 http://127.0.0.1:${hostLoopback.port}/ >/dev/null 2>&1; ! curl -fsS --max-time 1 http://1.1.1.1/ >/dev/null 2>&1`,
        ],
        environment,
        "/work/broker.sock",
        18765,
      );
      expect(invocation.command).toBe("/usr/bin/unshare");
      expect(invocation.args).toContain("--net");
      const child = Bun.spawn([invocation.command, ...invocation.args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const status = await Promise.race([
        child.exited,
        Bun.sleep(10_000).then(() => {
          child.kill("SIGKILL");
          return -1;
        }),
      ]);
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      if (status !== 0) throw new Error(`isolated broker failed: ${stderr || stdout}`);
      expect(status).toBe(0);
    } finally {
      broker.stop(true);
      hostLoopback.stop(true);
    }
  });
});
