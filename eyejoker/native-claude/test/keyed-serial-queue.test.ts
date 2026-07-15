import { describe, expect, test } from "bun:test";
import { KeyedSerialQueue } from "../src/keyed-serial-queue";

describe("KeyedSerialQueue", () => {
  test("serializes the same key while allowing a different key to run", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = queue.run("message-1", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run("message-1", async () => {
      events.push("second");
    });
    const other = queue.run("message-2", async () => {
      events.push("other");
    });

    await other;
    expect(events).toEqual(["first:start", "other"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "other", "first:end", "second"]);
  });

  test("continues a key after a failed lifecycle event", async () => {
    const queue = new KeyedSerialQueue();
    const first = queue.run("message", async () => {
      throw new Error("event failed");
    });
    const second = queue.run("message", async () => "continued");
    await expect(first).rejects.toThrow("event failed");
    expect(await second).toBe("continued");
  });
});
