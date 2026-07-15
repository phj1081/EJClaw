import { describe, expect, test } from "bun:test";
import { renderStatusSnapshot } from "../src/status-format";
import type { JobRecord } from "../src/types";

function job(status: JobRecord["status"], routeId = "cleanapo"): JobRecord {
  return {
    id: crypto.randomUUID(),
    routeId,
    lockKey: routeId,
    conversationKey: `${routeId}:thread`,
    channelId: "thread",
    threadId: "thread",
    messageId: crypto.randomUUID(),
    authorId: "owner",
    prompt: "task",
    attachmentPaths: [],
    status,
    sessionId: crypto.randomUUID(),
    attempts: 1,
    startedBefore: false,
    recoveryReason: null,
    pid: status === "running" ? 123 : null,
    result: null,
    error: null,
    finalStatus: null,
    deliveryAttempts: 0,
    deliveryAfter: null,
    deliveryError: null,
    progressMessageId: null,
    progressText: null,
    mainModel: null,
    subagentModels: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    startedAt: status === "running" ? "2026-07-15T00:00:01.000Z" : null,
    heartbeatAt: status === "running" ? "2026-07-15T00:00:02.000Z" : null,
    completedAt: null,
  };
}

describe("native runtime status", () => {
  test("reports idle without inventing activity", () => {
    expect(renderStatusSnapshot([]).state).toBe("idle");
  });

  test("reports real running and queued jobs", () => {
    const status = renderStatusSnapshot(
      [job("running"), job("queued", "crawler")],
      "2026-07-15T00:00:10.000Z",
    );
    expect(status.state).toBe("working");
    expect(status.running).toHaveLength(1);
    expect(status.queued).toHaveLength(1);
  });
});
