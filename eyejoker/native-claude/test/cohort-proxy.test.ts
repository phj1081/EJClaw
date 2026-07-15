import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForPort(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return Number(JSON.parse(readFileSync(path, "utf8")).port);
    await Bun.sleep(20);
  }
  throw new Error("proxy readiness timeout");
}

describe("cohort credential proxy", () => {
  test("requires an ephemeral client capability before injecting the upstream key", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return Response.json({
          apiKey: request.headers.get("x-api-key"),
          authorization: request.headers.get("authorization"),
        });
      },
    });
    const root = mkdtempSync(join(tmpdir(), "cohort-proxy-test-"));
    roots.push(root);
    const portFile = join(root, "port.json");
    const child = spawn(process.execPath, [join(import.meta.dir, "..", "src", "cohort-proxy.ts"), portFile], {
      env: {
        HOME: process.env.HOME ?? "/tmp",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
        ANTHROPIC_API_KEY: "upstream-secret-test",
        COHORT_PROXY_CLIENT_TOKEN: "ephemeral-client-test",
        COHORT_PROXY_MAX_REQUESTS: "4",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    try {
      const port = await waitForPort(portFile);
      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/messages`);
      expect(unauthorized.status).toBe(401);

      const escapedPath = await fetch(`http://127.0.0.1:${port}/v1/messages/../secret`, {
        headers: { "x-api-key": "ephemeral-client-test" },
      });
      expect(escapedPath.status).toBe(404);

      const authorized = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        headers: { "x-api-key": "ephemeral-client-test" },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual({
        apiKey: "upstream-secret-test",
        authorization: "Bearer upstream-secret-test",
      });
    } finally {
      child.kill("SIGTERM");
      upstream.stop(true);
    }
  });
});
