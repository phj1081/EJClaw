import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupExpiredAttachmentDirs } from "../src/attachment-cleanup";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("attachment retention", () => {
  test("removes only stale inactive message directories", () => {
    const root = join(tmpdir(), `native-attachments-${crypto.randomUUID()}`);
    roots.push(root);
    const stale = join(root, "stale-message");
    const fresh = join(root, "fresh-message");
    const active = join(root, "active-message");
    for (const directory of [stale, fresh, active]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "input.txt"), directory);
    }
    const nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    const old = new Date(nowMs - 8 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(active, old, old);
    utimesSync(fresh, new Date(nowMs), new Date(nowMs));

    const deleted = cleanupExpiredAttachmentDirs(root, {
      activePaths: [join(active, "input.txt")],
      nowMs,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(deleted).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(active)).toBe(true);
  });
});
