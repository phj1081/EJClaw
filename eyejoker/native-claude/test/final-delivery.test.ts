import { describe, expect, test } from "bun:test";
import { deliveryNonce, deliverPendingChunks, type DeliveryPlan } from "../src/final-delivery";

describe("durable final chunk delivery", () => {
  test("reconciles a Discord-accepted chunk after a crash before the SQLite ack", async () => {
    const plan: DeliveryPlan = { chunks: ["already sent", "new"], cursor: 0 };
    const sent: number[] = [];
    const marked: Array<[number, string]> = [];
    await deliverPendingChunks(
      "crash-job",
      plan,
      async (index) => {
        sent.push(index);
        return `new-message-${index}`;
      },
      async (index, messageId) => {
        marked.push([index, messageId]);
        plan.cursor = index + 1;
      },
      async (index, nonce) => {
        expect(nonce).toBe(deliveryNonce("crash-job", index));
        return index === 0 ? "existing-message-0" : null;
      },
    );
    expect(sent).toEqual([1]);
    expect(marked).toEqual([
      [0, "existing-message-0"],
      [1, "new-message-1"],
    ]);
    expect(plan.cursor).toBe(2);
  });

  test("resumes after the last accepted chunk and uses stable Discord nonces", async () => {
    const plan: DeliveryPlan = {
      chunks: ["one", "two", "three"],
      cursor: 0,
      files: [{ path: "/tmp/result.png", name: "result.png" }],
    };
    const sent: Array<{ index: number; content: string; nonce: string; files: string[] }> = [];
    let failSecond = true;

    const run = () =>
      deliverPendingChunks(
        "job-123",
        plan,
        async (index, content, nonce, files) => {
          sent.push({ index, content, nonce, files: files.map((file) => file.path) });
          if (index === 1 && failSecond) throw new Error("Discord unavailable");
          return `message-${index}`;
        },
        async (index) => {
          plan.cursor = index + 1;
        },
      );

    await expect(run()).rejects.toThrow("Discord unavailable");
    expect(plan.cursor).toBe(1);
    expect(sent.map(({ index }) => index)).toEqual([0, 1]);
    expect(sent[0]?.files).toEqual(["/tmp/result.png"]);
    expect(sent[1]?.files).toEqual([]);

    const failedNonce = sent[1]?.nonce;
    failSecond = false;
    await run();

    expect(sent.map(({ index }) => index)).toEqual([0, 1, 1, 2]);
    expect(sent[2]?.nonce).toBe(failedNonce);
    expect(sent[0]?.nonce).toBe(deliveryNonce("job-123", 0));
    expect(plan.cursor).toBe(3);
  });
});
