import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/store";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

function store() {
  const path = join(tmpdir(), `native-state-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return new StateStore(path);
}

function input(routeId: string, conversationKey: string, messageId: string) {
  return {
    routeId,
    conversationKey,
    channelId: routeId,
    threadId: null,
    messageId,
    authorId: "owner",
    prompt: `task-${messageId}`,
    attachmentPaths: [],
  };
}

describe("durable job store", () => {
  test("serializes jobs per project while allowing another project", () => {
    const db = store();
    db.enqueue(input("cleanapo", "cleanapo:one", "m1"));
    db.enqueue(input("cleanapo", "cleanapo:two", "m2"));
    db.enqueue(input("crawler", "crawler:one", "m3"));

    const first = db.claimNext(2);
    expect(first?.routeId).toBe("cleanapo");
    const second = db.claimNext(2);
    expect(second?.routeId).toBe("crawler");
    expect(db.claimNext(2)).toBeNull();
  });

  test("persists one Claude session per Discord thread", () => {
    const db = store();
    const first = db.enqueue(input("cleanapo", "cleanapo:thread-a", "m1"));
    const followup = db.enqueue(input("cleanapo", "cleanapo:thread-a", "m2"));
    const other = db.enqueue(input("cleanapo", "cleanapo:thread-b", "m3"));
    expect(followup.sessionId).toBe(first.sessionId);
    expect(other.sessionId).not.toBe(first.sessionId);
  });

  test("requeues interrupted work and marks it for same-session recovery", () => {
    const db = store();
    const queued = db.enqueue(input("cleanapo", "cleanapo:one", "m1"));
    const running = db.claimNext(1);
    expect(running?.id).toBe(queued.id);

    const recovered = db.recoverInterrupted("service restart");
    expect(recovered).toBe(1);
    const resumed = db.claimNext(1);
    expect(resumed?.sessionId).toBe(queued.sessionId);
    expect(resumed?.recoveryReason).toBe("service restart");
    expect(resumed?.startedBefore).toBe(true);
  });

  test("turns an interrupted run into a deliverable failure at the retry bound", () => {
    const db = store();
    const queued = db.enqueue(input("crawler", "crawler:one", "m5"));
    db.claimNext(1);
    expect(db.recoverInterrupted("restart loop", 1)).toBe(1);
    const recovered = db.getJob(queued.id);
    expect(recovered?.status).toBe("delivering");
    expect(recovered?.finalStatus).toBe("failed");
  });

  test("deduplicates the same Discord message id", () => {
    const db = store();
    const a = db.enqueue(input("cleanapo", "cleanapo:one", "same"));
    const b = db.enqueue(input("cleanapo", "cleanapo:one", "same"));
    expect(b.id).toBe(a.id);
    expect(db.listJobs()).toHaveLength(1);
  });

  test("persists final chunks, cursor and accepted message ids across restarts", () => {
    const db = store();
    const job = db.enqueue(input("delivery", "delivery:one", "delivery-message"));

    const files = [{ path: "/tmp/result.png", name: "result.png" }];
    expect(db.prepareDelivery(job.id, ["one", "two"], files)).toEqual({
      chunks: ["one", "two"],
      cursor: 0,
      messageIds: [],
      files,
    });
    db.markDeliveryChunk(job.id, 0, "discord-1");

    const reopened = db.prepareDelivery(job.id, ["different"], []);
    expect(reopened).toEqual({
      chunks: ["one", "two"],
      cursor: 1,
      messageIds: ["discord-1"],
      files,
    });
    expect(db.getJob(job.id)?.deliveryCursor).toBe(1);
    expect(db.getJob(job.id)?.deliveryMessageIds).toEqual(["discord-1"]);
    expect(db.getJob(job.id)?.deliveryFiles).toEqual(files);
    db.close();
  });

  test("forgets a temporary progress message after Discord cleanup", () => {
    const db = store();
    const job = db.enqueue(input("cleanapo", "cleanapo:one", "progress"));
    db.claimNext(1);
    db.setProgress(job.id, "discord-progress-123", "⏳ 작업 진행 중");
    expect(db.getJob(job.id)?.progressMessageId).toBe("discord-progress-123");

    db.clearProgress(job.id);
    expect(db.getJob(job.id)?.progressMessageId).toBeNull();
    expect(db.getJob(job.id)?.progressText).toBeNull();
  });
});
