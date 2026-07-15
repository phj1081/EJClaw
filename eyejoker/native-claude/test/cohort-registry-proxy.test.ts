import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForReady(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, "utf8")) as { port: number };
      return value.port;
    }
    await Bun.sleep(20);
  }
  throw new Error("registry proxy readiness timeout");
}

describe("cohort registry proxy", () => {
  test("allows only read requests to the fixed registry and rewrites tarball origins", async () => {
    let upstreamHits = 0;
    let upstreamPort = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        upstreamHits += 1;
        const path = new URL(request.url).pathname;
        if (path === "/pkg") {
          return Response.json({
            versions: {
              "1.0.0": { dist: { tarball: `http://127.0.0.1:${upstreamPort}/pkg/-/pkg-1.0.0.tgz` } },
            },
          });
        }
        if (path === "/pkg/-/pkg-1.0.0.tgz") return new Response("tarball-bytes");
        return new Response("not found", { status: 404 });
      },
    });
    upstreamPort = upstream.port!;
    const root = mkdtempSync(join(tmpdir(), "cohort-registry-proxy-"));
    roots.push(root);
    const readyFile = join(root, "ready.json");
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "..", "src", "cohort-registry-proxy.ts"), readyFile],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          COHORT_REGISTRY_UPSTREAM: `http://127.0.0.1:${upstream.port}/`,
          COHORT_REGISTRY_CLIENT_ORIGIN: "http://127.0.0.1:18764",
        },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    children.push(child);
    try {
      const port = await waitForReady(readyFile);
      const metadata = await fetch(`http://127.0.0.1:${port}/pkg`);
      expect(metadata.status).toBe(200);
      const body = await metadata.json() as { versions: Record<string, { dist: { tarball: string } }> };
      expect(body.versions["1.0.0"]!.dist.tarball).toBe(
        "http://127.0.0.1:18764/pkg/-/pkg-1.0.0.tgz",
      );
      const tarball = await fetch(`http://127.0.0.1:${port}/pkg/-/pkg-1.0.0.tgz`);
      expect(await tarball.text()).toBe("tarball-bytes");
      const beforePost = upstreamHits;
      expect((await fetch(`http://127.0.0.1:${port}/pkg`, { method: "POST" })).status).toBe(405);
      expect(upstreamHits).toBe(beforePost);
    } finally {
      child.kill("SIGTERM");
      upstream.stop(true);
    }
  });
});
