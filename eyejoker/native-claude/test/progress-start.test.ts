import { describe, expect, test } from "bun:test";
import {
  progressReplyMessageId,
  recoverMissingSteeringProgress,
  startProgressBeforeTyping,
} from "../src/progress-start";

describe("Discord progress startup isolation", () => {
  test("starts progress before typing and does not fail when typing fails", async () => {
    const events: string[] = [];

    await expect(
      startProgressBeforeTyping({
        startProgress: async () => {
          events.push("progress");
        },
        sendTyping: async () => {
          events.push("typing");
          throw new Error("Discord typing 500");
        },
        onTypingError: (error) => {
          events.push(error instanceof Error ? error.message : String(error));
        },
      }),
    ).resolves.toBeNull();

    expect(events).toEqual(["progress", "typing", "Discord typing 500"]);
  });

  test("returns the typing channel handle after progress starts", async () => {
    const channel = { id: "thread-channel" };
    const result = await startProgressBeforeTyping({
      startProgress: async () => undefined,
      sendTyping: async () => channel,
      onTypingError: () => {
        throw new Error("unexpected typing failure");
      },
    });

    expect(result).toBe(channel);
  });

  test("anchors synthetic watcher progress to the real steering message", () => {
    expect(progressReplyMessageId("github-watch:watch-id:signal", null)).toBeNull();
    expect(progressReplyMessageId("github-watch:watch-id:signal", "1527480195374776330")).toBe(
      "1527480195374776330",
    );
  });

  test("keeps an original real Discord message as the progress reply target", () => {
    expect(progressReplyMessageId("1527469236354678945", null)).toBe("1527469236354678945");
    expect(progressReplyMessageId("1527469236354678945", "not-a-snowflake")).toBe("1527469236354678945");
  });

  test("recovers missing progress for a real steering message", async () => {
    const recovered: string[] = [];

    await expect(
      recoverMissingSteeringProgress(null, async () => {
        recovered.push("reply-to-steering-and-start");
      }),
    ).resolves.toBe(true);

    expect(recovered).toEqual(["reply-to-steering-and-start"]);
  });

  test("does not duplicate an existing progress card during steering", async () => {
    let recoveryCalls = 0;

    await expect(
      recoverMissingSteeringProgress("existing-progress", async () => {
        recoveryCalls += 1;
      }),
    ).resolves.toBe(false);

    expect(recoveryCalls).toBe(0);
  });
});
