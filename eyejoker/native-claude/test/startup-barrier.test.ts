import { describe, expect, test } from "bun:test";
import { StartupBarrier } from "../src/startup-barrier";

describe("startup readiness barrier", () => {
  test("holds ingress until recovery completes", async () => {
    const barrier = new StartupBarrier();
    const events: string[] = [];
    const handler = (async () => {
      events.push("handler-waiting");
      await barrier.wait();
      events.push("handler-running");
    })();
    await Promise.resolve();
    expect(events).toEqual(["handler-waiting"]);
    barrier.ready();
    await handler;
    expect(events).toEqual(["handler-waiting", "handler-running"]);
  });

  test("fails waiting ingress when startup recovery fails", async () => {
    const barrier = new StartupBarrier();
    const waiting = barrier.wait();
    barrier.fail(new Error("migration failed"));
    await expect(waiting).rejects.toThrow("migration failed");
  });

  test("gates every Discord ingress path in the bridge", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source.match(/await startupBarrier\.wait\(\)/g)?.length).toBe(5);
    expect(source).toContain("startupBarrier.ready()");
    expect(source).toContain("startupBarrier.fail(error)");
  });
});
