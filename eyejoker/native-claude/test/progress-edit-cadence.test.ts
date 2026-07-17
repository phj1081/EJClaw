import { describe, expect, test } from "bun:test";
import {
  PROGRESS_EDIT_INTERVAL_MS,
  ProgressEditGate,
  progressEditDelayMs,
} from "../src/progress-edit-cadence";

describe("progress edit cadence", () => {
  test("coalesces every progress update to at most one edit per two seconds", () => {
    expect(PROGRESS_EDIT_INTERVAL_MS).toBe(2_000);
    expect(progressEditDelayMs(10_000, 10_000)).toBe(2_000);
    expect(progressEditDelayMs(10_000, 11_999)).toBe(1);
    expect(progressEditDelayMs(10_000, 12_000)).toBe(0);
  });

  test("does not allow a second edit while Discord is still editing the first one", () => {
    const gate = new ProgressEditGate();
    gate.markDirty();
    expect(gate.scheduleDelay(10_000)).toBe(0);
    expect(gate.beginEdit()).toBe(true);

    gate.markDirty();
    expect(gate.scheduleDelay(10_500)).toBeNull();

    gate.finishEdit(10_700, true);
    expect(gate.scheduleDelay(10_700)).toBe(2_000);
  });

  test("keeps a failed Discord edit dirty so it is retried", () => {
    const gate = new ProgressEditGate();
    gate.markDirty();
    expect(gate.scheduleDelay(10_000)).toBe(0);
    expect(gate.beginEdit()).toBe(true);

    gate.finishEdit(10_000, false);

    expect(gate.scheduleDelay(10_000)).toBe(PROGRESS_EDIT_INTERVAL_MS);
  });

  test("does not retry a clean no-op card render", () => {
    const gate = new ProgressEditGate();
    gate.markDirty();
    expect(gate.scheduleDelay(10_000)).toBe(0);
    expect(gate.beginEdit()).toBe(true);

    gate.finishEdit(10_000, false, false);

    expect(gate.scheduleDelay(10_000)).toBeNull();
  });

  test("releases a stale schedule so a later dirty repost can arm again", () => {
    const gate = new ProgressEditGate();
    gate.markDirty();
    expect(gate.scheduleDelay(10_000)).toBe(0);

    gate.releaseSchedule();
    expect(gate.scheduleDelay(10_000)).toBe(0);
    expect(gate.beginEdit()).toBe(true);
  });
});
