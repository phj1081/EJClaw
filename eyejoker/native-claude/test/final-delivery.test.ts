import { describe, expect, test } from "bun:test";
import { deliveryNonce, deliverPendingChunks, type DeliveryPlan } from "../src/final-delivery";

describe("durable final chunk delivery", () => {
  test("resumes after the last accepted chunk and uses stable Discord nonces", async () => {
    const plan: DeliveryPlan = { chunks: ["one", "two", "three"], cursor: 0 };
    const sent: Array<{ index: number; content: string; nonce: string }> = [];
    let failSecond = true;

    const run = () =>
      deliverPendingChunks(
        "job-123",
        plan,
        async (index, content, nonce) => {
          sent.push({ index, content, nonce });
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

    const failedNonce = sent[1]?.nonce;
    failSecond = false;
    await run();

    expect(sent.map(({ index }) => index)).toEqual([0, 1, 1, 2]);
    expect(sent[2]?.nonce).toBe(failedNonce);
    expect(sent[0]?.nonce).toBe(deliveryNonce("job-123", 0));
    expect(plan.cursor).toBe(3);
  });
});
