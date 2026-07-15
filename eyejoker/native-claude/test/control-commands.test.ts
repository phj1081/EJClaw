import { describe, expect, test } from "bun:test";
import { parseControlCommand } from "../src/control-commands";

describe("Discord Claude controls", () => {
  test("parses persistent conversation overrides", () => {
    expect(parseControlCommand("!model gpt-5.6-sol")).toEqual({ kind: "setting", field: "model", value: "gpt-5.6-sol" });
    expect(parseControlCommand("!model default")).toEqual({ kind: "setting", field: "model", value: null });
    expect(parseControlCommand("!permission plan")).toEqual({ kind: "setting", field: "permissionMode", value: "plan" });
    expect(parseControlCommand("!effort max")).toEqual({ kind: "setting", field: "effort", value: "max" });
  });

  test("parses session and raw slash controls", () => {
    expect(parseControlCommand("!fork")).toEqual({ kind: "fork" });
    expect(parseControlCommand("!branch list")).toEqual({ kind: "branches" });
    expect(parseControlCommand("!branch use abc12345")).toEqual({ kind: "useBranch", prefix: "abc12345" });
    expect(parseControlCommand("!checkpoint list")).toEqual({ kind: "checkpoints" });
    expect(parseControlCommand("!rewind preview user-uuid")).toEqual({
      kind: "rewindPreview",
      checkpoint: "user-uuid",
    });
    expect(parseControlCommand("!rewind apply op-uuid")).toEqual({ kind: "rewindApply", operationId: "op-uuid" });
    expect(parseControlCommand("!reset")).toEqual({ kind: "reset" });
    expect(parseControlCommand("!settings")).toEqual({ kind: "settings" });
    expect(parseControlCommand("!compact")).toEqual({ kind: "raw", prompt: "/compact" });
    expect(parseControlCommand("!claude /review 123")).toEqual({ kind: "raw", prompt: "/review 123" });
    expect(parseControlCommand("!background 긴 작업")).toEqual({ kind: "background", prompt: "긴 작업" });
    expect(parseControlCommand("!rewind abc")).toEqual({
      kind: "unsupported",
      message: expect.stringContaining("preview"),
    });
  });

  test("leaves normal prompts untouched", () => {
    expect(parseControlCommand("버그 고쳐줘")).toBeNull();
  });
});
