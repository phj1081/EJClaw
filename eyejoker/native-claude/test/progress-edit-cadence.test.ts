import { describe, expect, test } from "bun:test";
import { PROGRESS_EDIT_INTERVAL_MS, progressEditDelayMs } from "../src/progress-edit-cadence";

describe("progress edit cadence", () => {
  test("coalesces every progress update to at most one edit per two seconds", () => {
    expect(PROGRESS_EDIT_INTERVAL_MS).toBe(2_000);
    expect(progressEditDelayMs(10_000, 10_000)).toBe(2_000);
    expect(progressEditDelayMs(10_000, 11_999)).toBe(1);
    expect(progressEditDelayMs(10_000, 12_000)).toBe(0);
  });
});
