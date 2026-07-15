import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildScheduledJobPrompt,
  normalizePromptText,
  readSecurePromptFile,
  scheduleIdentity,
} from "../src/admin-utils";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

function promptFile(mode: number, content = "daily task"): string {
  const path = join(tmpdir(), `native-schedule-${crypto.randomUUID()}.prompt`);
  paths.push(path);
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

describe("scheduled native jobs", () => {
  test("reads only non-empty private prompt files", () => {
    expect(readSecurePromptFile(promptFile(0o600))).toBe("daily task");
    expect(() => readSecurePromptFile(promptFile(0o644))).toThrow("mode 600");
    expect(() => readSecurePromptFile(promptFile(0o600, "  "))).toThrow("empty");
  });

  test("unwraps JSON prompt wrappers and keeps long tasks as file references", () => {
    const longBody = `말드할라 작업 ${"x".repeat(2200)}`;
    const wrapped = JSON.stringify({ prompt: longBody });
    expect(normalizePromptText(wrapped)).toBe(longBody);
    const path = promptFile(0o600, wrapped);
    const built = buildScheduledJobPrompt(path, wrapped);
    expect(built.attachmentPaths).toEqual([path]);
    expect(built.prompt).toContain(path);
    expect(built.prompt.length).toBeLessThan(1200);
  });

  test("uses a stable date-scoped id so Persistent timers cannot duplicate a run", () => {
    const identity = scheduleIdentity(
      "maldhalla-balance",
      "maldhalla-balance-daily",
      new Date("2026-07-15T01:00:00Z"),
      "Asia/Seoul",
    );
    expect(identity).toEqual({
      messageId: "scheduled:maldhalla-balance-daily:2026-07-15",
      conversationKey: "maldhalla-balance:scheduled:maldhalla-balance-daily",
    });
  });
});
