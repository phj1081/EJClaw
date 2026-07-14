import { describe, expect, test } from "bun:test";
import {
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

  test("does not reply to synthetic or scheduled non-Discord ids", () => {
    expect(isReplyableMessageId("123456789012345678")).toBe(true);
    expect(isReplyableMessageId("synthetic:test")).toBe(false);
    expect(isReplyableMessageId("scheduled:daily:2026-07-15")).toBe(false);
  });

  test("prevents attachment path traversal", () => {
    expect(sanitizeAttachmentName("../../secret.env")).toBe("secret.env");
    expect(sanitizeAttachmentName("screen shot.png")).toBe("screen_shot.png");
  });
});
