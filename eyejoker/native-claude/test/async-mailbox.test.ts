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
