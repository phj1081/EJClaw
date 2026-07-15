import { describe, expect, test } from "bun:test";
import { ProgressLifecycle, PROGRESS_AFTER_MS } from "../src/progress-lifecycle";

describe("transient Discord progress lifecycle", () => {
  test("does not display a progress card before the NanoClaw 30-second threshold", () => {
    const startedAt = 1_000_000;
    const lifecycle = new ProgressLifecycle({ startedAt, existingMessageId: null });

    expect(lifecycle.delayUntilVisible(startedAt)).toBe(PROGRESS_AFTER_MS);
    expect(lifecycle.isDue(startedAt + PROGRESS_AFTER_MS - 1)).toBe(false);
    expect(lifecycle.isDue(startedAt + PROGRESS_AFTER_MS)).toBe(true);
  });

  test("resumes an existing card immediately after a bridge restart", () => {
    const lifecycle = new ProgressLifecycle({ startedAt: 1_000_000, existingMessageId: "progress-123" });

    expect(lifecycle.existingMessageId()).toBe("progress-123");
    expect(lifecycle.delayUntilVisible(1_000_001)).toBe(0);
  });

  test("keeps the temporary card until final user-facing delivery succeeds, then cleans it once", () => {
    const lifecycle = new ProgressLifecycle({ startedAt: 1_000_000, existingMessageId: null });
    lifecycle.recordPosted("progress-123");

    expect(lifecycle.messageId()).toBe("progress-123");
    expect(lifecycle.takeCleanupAfterFinalDelivery()).toBe("progress-123");
    expect(lifecycle.takeCleanupAfterFinalDelivery()).toBeNull();
  });
});
