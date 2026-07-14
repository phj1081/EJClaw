import { describe, expect, test } from "bun:test";
import {
  buildClaudeInvocation,
  buildGoalPrompt,
  formatFinalMessage,
  formatProgressMessage,
  parseClaudeOutput,
} from "../src/protocol";

import type { RouteConfig } from "../src/types";

const route: RouteConfig = {
  id: "cleanapo",
  discordChannelId: "100",
  cwd: "/tmp/project",
  model: "claude-fable-5",
  effort: "high",
  permissionMode: "bypassPermissions" as const,
  requireMention: false,
  instructions: "apps/soriq만 담당",
};

describe("Claude protocol", () => {
  test("forces a bounded verifiable goal instead of merely suggesting continuation", () => {
    const prompt = buildGoalPrompt(route, "버그 고치고 PR까지", [], null);
    expect(prompt.startsWith("/goal ")).toBe(true);
    expect(prompt).toContain("버그 고치고 PR까지");
    expect(prompt).toContain("테스트");
    expect(prompt).toContain("진짜 외부 블로커");
    expect(prompt).toContain("apps/soriq만 담당");
  });

  test("recovery prompt explicitly resumes existing artifacts", () => {
    const prompt = buildGoalPrompt(route, "원래 작업", ["/tmp/a.png"], "service restart");
    expect(prompt).toContain("service restart");
    expect(prompt).toContain("/tmp/a.png");
    expect(prompt).toContain("기존 변경을 버리지 말고");
  });

  test("uses session-id for a new run and resume for subsequent runs", () => {
    const fresh = buildClaudeInvocation(route, "hello", "session-1", false);
    expect(fresh.args).toContain("--session-id");
    expect(fresh.args).not.toContain("--resume");
    const resumed = buildClaudeInvocation(route, "hello", "session-1", true);
    expect(resumed.args).toContain("--resume");
    expect(resumed.args).not.toContain("--session-id");
    expect(resumed.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  });

  test("extracts result and session id from Claude json output", () => {
    const parsed = parseClaudeOutput(
      '{"type":"result","subtype":"success","result":"완료","session_id":"abc","is_error":false}',
      "",
      0,
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toBe("완료");
    expect(parsed.sessionId).toBe("abc");
  });

  test("mentions owner only in final output", () => {
    const progress = formatProgressMessage("테스트 실행", 65);
    const final = formatFinalMessage("216851709744513024", true, "완료", 65);
    expect(progress).not.toContain("216851709744513024");
    expect(final.match(/<@216851709744513024>/g)).toHaveLength(1);
  });
});
