import { describe, expect, test } from "bun:test";
import {
  findBotMessageByNonce,
  type ReconcileMessage,
  type ReconcileMessageCollection,
  type ReconcileMessageFetcher,
} from "../src/discord-reconcile";

function history(messages: ReconcileMessage[]): ReconcileMessageFetcher {
  return {
    async fetch({ limit, before }): Promise<ReconcileMessageCollection> {
      const start = before ? messages.findIndex((message) => message.id === before) + 1 : 0;
      const page = messages.slice(start, start + limit);
      return {
        size: page.length,
        *values() {
          yield* page;
        },
      };
    },
  };
}

function message(index: number, nonce: string | null = null, authorId = "bot"): ReconcileMessage {
  return {
    id: String(10_000 - index),
    nonce,
    createdTimestamp: 1_000_000 - index * 1_000,
    author: { id: authorId },
  };
}

describe("Discord outbox nonce reconciliation", () => {
  test("paginates beyond the newest 100 messages back to the creation boundary", async () => {
    const messages = Array.from({ length: 240 }, (_, index) => message(index));
    messages[149] = message(149, "durable-nonce");

    const found = await findBotMessageByNonce(history(messages), "bot", "durable-nonce", 700_000, {
      clockSkewMs: 0,
    });

    expect(found?.id).toBe(messages[149].id);
  });

  test("ignores another author's matching nonce", async () => {
    const messages = [message(0, "same", "other"), message(1)];
    expect(await findBotMessageByNonce(history(messages), "bot", "same", 900_000)).toBeNull();
  });

  test("stops after crossing the durable creation-time boundary", async () => {
    const messages = Array.from({ length: 150 }, (_, index) => message(index));
    messages[120] = message(120, "too-old");
    expect(
      await findBotMessageByNonce(history(messages), "bot", "too-old", 950_000, { clockSkewMs: 0 }),
    ).toBeNull();
  });

  test("fails closed instead of resending when pagination cannot reach the boundary", async () => {
    const messages = Array.from({ length: 300 }, (_, index) => message(index));
    await expect(
      findBotMessageByNonce(history(messages), "bot", "missing", 0, {
        maxPages: 2,
        clockSkewMs: 0,
      }),
    ).rejects.toThrow("refusing duplicate send");
  });
});
