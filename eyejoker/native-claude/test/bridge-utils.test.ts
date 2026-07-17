import { describe, expect, test } from "bun:test";
import {
  appendDiscordContext,
  buildSteeringUserTurn,
  conversationKey,
  isReplyableMessageId,
  isSupportedMessageType,
  sanitizeAttachmentName,
  stripBotMention,
} from "../src/bridge-utils";

const route = { id: "cleanapo" };

describe("Discord bridge helpers", () => {
  test("keeps one Claude conversation per Discord thread", () => {
    expect(conversationKey(route, "thread-1")).toBe("cleanapo:thread-1");
    expect(conversationKey(route, "channel-1")).toBe("cleanapo:channel-1");
  });

  test("accepts only normal and reply messages", () => {
    expect(isSupportedMessageType(0)).toBe(true);
    expect(isSupportedMessageType(19)).toBe(true);
    expect(isSupportedMessageType(18)).toBe(false);
  });

  test("strips only the runtime bot mention", () => {
    expect(stripBotMention("<@123> 작업해 <@999>", "123")).toBe("작업해 <@999>");
  });

  test("uses a Discord snowflake allowlist for reply references", () => {
    expect(isReplyableMessageId("12345678901234567")).toBe(true);
    expect(isReplyableMessageId("12345678901234567890")).toBe(true);
    expect(isReplyableMessageId("1234567890123456")).toBe(false);
    expect(isReplyableMessageId("123456789012345678901")).toBe(false);
    expect(isReplyableMessageId("0".repeat(18))).toBe(false);
    expect(isReplyableMessageId("synthetic:test")).toBe(false);
    expect(isReplyableMessageId("scheduled:daily:2026-07-15")).toBe(false);
    expect(isReplyableMessageId("github-watch:watch:signal")).toBe(false);
    expect(isReplyableMessageId("cohort-verifier:notice")).toBe(false);
    expect(isReplyableMessageId("steering-edit:message:1")).toBe(false);
    expect(isReplyableMessageId("steering-delete:message:1")).toBe(false);
  });

  test("keeps only an explicit bounded reply and drops ambient Discord history", () => {
    const prompt = appendDiscordContext("현재 요청", {
      reply: { id: "r1", author: "눈쟁이", content: `원본 요청${"x".repeat(2_000)}`, attachments: ["spec.png"] },
      history: [
        { id: "h1", author: "Claude", content: "이전 답변", attachments: [] },
        { id: "r1", author: "눈쟁이", content: "중복 reply", attachments: [] },
      ],
    });
    expect(prompt).toContain("명시적으로 답장한 메시지");
    expect(prompt).toContain("눈쟁이: 원본 요청");
    expect(prompt).toContain("첨부: spec.png");
    expect(prompt).not.toContain("최근 대화");
    expect(prompt).not.toContain("Claude: 이전 답변");
    expect(prompt).not.toContain("중복 reply");
    expect(prompt.endsWith("현재 요청")).toBe(true);
    expect(prompt.length).toBeLessThan(1_500);
  });

  test("returns the exact request when there is no explicit reply even if ambient history exists", () => {
    const prompt = appendDiscordContext("현재 요청", {
      reply: null,
      history: [{ id: "h1", author: "Claude", content: "자동 주입하면 안 됨", attachments: [] }],
    });
    expect(prompt).toBe("현재 요청");
  });

  test("keeps an ordinary same-thread steering turn free of bridge provenance wrappers", () => {
    expect(buildSteeringUserTurn("후속 요청", false, "unused")).toBe("후속 요청");
    expect(buildSteeringUserTurn("contextual", true, "/compact")).toBe("/compact");
  });

  test("prevents attachment path traversal", () => {
    expect(sanitizeAttachmentName("../../secret.env")).toBe("secret.env");
    expect(sanitizeAttachmentName("screen shot.png")).toBe("screen_shot.png");
  });
});
