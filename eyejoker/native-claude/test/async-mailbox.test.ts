import { describe, expect, test } from "bun:test";
import { AsyncMailbox } from "../src/async-mailbox";

describe("AsyncMailbox", () => {
  test("preserves push order and closes after queued values drain", async () => {
    const mailbox = new AsyncMailbox<string>();
    expect(mailbox.push("first")).toBe(true);
    expect(mailbox.push("second")).toBe(true);
    mailbox.close();
    expect(mailbox.push("late")).toBe(false);

    const received: string[] = [];
    for await (const value of mailbox) received.push(value);
    expect(received).toEqual(["first", "second"]);
  });

  test("replaces or removes values that have not been consumed", async () => {
    const mailbox = new AsyncMailbox<{ id: string; content: string }>();
    mailbox.push({ id: "a", content: "old" });
    mailbox.push({ id: "b", content: "delete-me" });

    expect(mailbox.replace((value) => value.id === "a", { id: "a", content: "new" })).toBe(true);
    expect(mailbox.remove((value) => value.id === "b")).toBe(true);
    expect(mailbox.remove((value) => value.id === "missing")).toBe(false);
    mailbox.close();

    const observed: Array<{ id: string; content: string }> = [];
    for await (const value of mailbox) observed.push(value);
    expect(observed).toEqual([{ id: "a", content: "new" }]);
  });

  test("rejects buffered mutations after close", () => {
    const mailbox = new AsyncMailbox<number>();
    mailbox.push(1);
    mailbox.close();
    expect(mailbox.replace((value) => value === 1, 2)).toBe(false);
    expect(mailbox.remove((value) => value === 1)).toBe(false);
  });

  test("wakes a waiting consumer and aborts with the original error", async () => {
    const mailbox = new AsyncMailbox<string>();
    const iterator = mailbox[Symbol.asyncIterator]();
    const pending = iterator.next();
    mailbox.push("ready");
    expect(await pending).toEqual({ value: "ready", done: false });

    const waiting = iterator.next();
    const failure = new Error("cancelled");
    mailbox.abort(failure);
    await expect(waiting).rejects.toBe(failure);
  });
});
