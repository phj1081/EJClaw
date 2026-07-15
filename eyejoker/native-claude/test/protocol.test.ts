import { describe, expect, test } from "bun:test";
import {
  buildClaudeInvocation,
  buildFinalChunkOptions,
  buildGoalPrompt,
  formatFinalMessage,
  formatProgressMessage,
  parseClaudeOutput,
} from "../src/protocol";

import type { RouteConfig } from "../src/types";
import { formatElapsedKorean, progressElapsedSeconds, workElapsedSeconds } from "../src/duration";

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
    expect(prompt).not.toContain("중간 진행은 Discord progress 카드");
    expect(prompt.split("\n")[0]!.length).toBeLessThan(200);
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

  test("uses stream-json with partial messages for live progress", () => {
    const fresh = buildClaudeInvocation(route, "hello", "session-1", false);
    expect(fresh.args).toContain("stream-json");
    expect(fresh.args).toContain("--include-partial-messages");
    expect(fresh.args).toContain("--include-hook-events");
    expect(fresh.args).toContain("--verbose");
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

  test("formats progress and final durations for humans", () => {
    expect(formatElapsedKorean(48)).toBe("48초");
    expect(formatElapsedKorean(728)).toBe("12분 8초");
    expect(formatElapsedKorean(4_328)).toBe("1시간 12분");
    expect(formatProgressMessage("테스트 실행", 4_328)).toContain("1시간 12분");
  });

  test("measures work from execution start instead of queue creation", () => {
    const now = Date.parse("2026-07-15T01:11:30.000Z");
    const startedAt = "2026-07-15T01:10:00.000Z";
    const createdAt = "2026-07-15T01:00:00.000Z";
    expect(workElapsedSeconds(startedAt, createdAt, now)).toBe(90);
    expect(progressElapsedSeconds(startedAt, createdAt, now)).toBe(90);
  });

  test("mentions owner once with work duration and actual model, without redundant success decoration", () => {
    const progress = formatProgressMessage("테스트 실행", 65);
    const final = formatFinalMessage(
      "216851709744513024",
      true,
      "완료",
      4_328,
      "claude-fable-5",
      ["gpt-5.6-sol"],
    );
    const failure = formatFinalMessage(
      "216851709744513024",
      false,
      "실패 원인",
      258,
      "claude-fable-5",
      [],
    );
    expect(progress).not.toContain("216851709744513024");
    expect(final).toBe("<@216851709744513024> · 작업 시간 1시간 12분 · fable-5 + gpt-5.6-sol\n완료");
    expect(final).not.toContain("✅");
    expect(final.split("\n")[0]).not.toContain("완료");
    expect(failure).toBe("<@216851709744513024> ⛔ 실패 · 작업 시간 4분 18초 · fable-5\n실패 원인");
    expect(final.match(/<@216851709744513024>/g)).toHaveLength(1);
  });

  test("uses a direct mention without a reply reference for final delivery", () => {
    const first = buildFinalChunkOptions("216851709744513024", "첫 청크", 0);
    const second = buildFinalChunkOptions("216851709744513024", "다음 청크", 1);
    expect(first).toEqual({ content: "첫 청크", allowedMentions: { users: ["216851709744513024"] } });
    expect(first).not.toHaveProperty("reply");
    expect(second).toEqual({ content: "다음 청크", allowedMentions: { parse: [] } });
  });
});
