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

  test("updates queued source messages but never rewrites an active execution", () => {
    const db = store();
    const queued = db.enqueue(input("cleanapo", "cleanapo:edit", "editable"));
    expect(db.updateQueuedPrompt("editable", "수정된 요청")?.prompt).toBe("수정된 요청");
    db.claimNext(1);
    expect(db.updateQueuedPrompt("editable", "늦은 수정")).toBeNull();
    expect(db.getJob(queued.id)?.prompt).toBe("수정된 요청");
  });

  test("cancels a queued or running job when its source message is deleted", () => {
    const db = store();
    const job = db.enqueue(input("cleanapo", "cleanapo:delete", "deletable"));
    expect(db.cancelByMessageId("deletable")?.id).toBe(job.id);
    expect(db.getJob(job.id)?.status).toBe("cancelled");
    expect(db.cancelByMessageId("deletable")).toBeNull();
  });

  test("persists conversation overrides and consumes fork/reset controls once", () => {
    const db = store();
    const first = db.enqueue(input("cleanapo", "cleanapo:controls", "controls-1"));
    db.setConversationSetting("cleanapo:controls", "model", "gpt-5.6-sol");
    db.setConversationSetting("cleanapo:controls", "permissionMode", "plan");
    db.setConversationSetting("cleanapo:controls", "effort", "max");
    expect(db.getConversationSettings("cleanapo:controls")).toEqual({
      model: "gpt-5.6-sol",
      permissionMode: "plan",
      effort: "max",
      forkNext: false,
    });
    db.requestFork("cleanapo:controls");
    expect(db.consumeFork("cleanapo:controls")).toBe(true);
    expect(db.consumeFork("cleanapo:controls")).toBe(false);
    const reset = db.resetSession("cleanapo:controls");
    expect(reset).not.toBe(first.sessionId);
    expect(db.sessionHasHistory("cleanapo:controls")).toBe(false);
  });

  test("preserves fork branches and can switch the active session pointer", () => {
    const db = store();
    const original = db.enqueue(input("branches", "branches:one", "branch-message"));
    const running = db.claimNext(1)!;
    const forkedSessionId = crypto.randomUUID();
    db.stageDelivery(
      running.id,
      { ok: true, result: "forked", sessionId: forkedSessionId, stderr: "", exitCode: 0 },
      "completed",
    );
    const branches = db.listSessionBranches(original.conversationKey);
    expect(branches.map((branch) => branch.sessionId).sort()).toEqual([original.sessionId, forkedSessionId].sort());
    expect(branches.find((branch) => branch.sessionId === forkedSessionId)?.status).toBe("active");

    db.useSessionBranch(original.conversationKey, original.sessionId.slice(0, 8));
    const followup = db.enqueue(input("branches", "branches:one", "branch-followup"));
    expect(followup.sessionId).toBe(original.sessionId);
  });

  test("preserves the first started_at across execution retries", () => {
    const db = store();
    const queued = db.enqueue(input("deadline", "deadline:one", "deadline-message"));
    const first = db.claimNext(1)!;
    const startedAt = first.startedAt;
    db.retryOrFail(
      first.id,
      { ok: false, result: "retry", sessionId: queued.sessionId, stderr: "failure", exitCode: 1 },
      2,
    );
    const second = db.claimNext(1)!;
    expect(second.startedAt).toBe(startedAt);
  });

  test("persists checkpoints and consumes rewind previews only once", () => {
    const db = store();
    const job = db.enqueue(input("rewind", "rewind:one", "rewind-message"));
    const checkpoint = crypto.randomUUID();
    db.recordSessionCheckpoint(job.id, checkpoint);
    expect(db.listSessionCheckpoints(job.conversationKey)[0]?.userMessageId).toBe(checkpoint);
    const operation = db.createRewindOperation(job.conversationKey, job.sessionId, checkpoint, {
      canRewind: true,
      filesChanged: ["src/a.ts"],
      insertions: 1,
      deletions: 2,
    });
    expect(db.getRewindOperation(job.conversationKey, operation.id.slice(0, 8))?.checkpoint).toBe(checkpoint);
    expect(db.markRewindApplied(operation.id)).toBe(true);
    expect(db.markRewindApplied(operation.id)).toBe(false);
  });

  test("persists follow-up steering message lifecycle across restart", () => {
    const path = join(tmpdir(), `native-steering-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const first = new StateStore(path);
    const job = first.enqueue(input("steering", "steering:one", "source-message"));
    const initialSdkId = crypto.randomUUID();
    const pending = first.beginSteeringInput({
      messageId: "followup-message",
      jobId: job.id,
      conversationKey: job.conversationKey,
      content: "처음 지시",
      sdkMessageId: initialSdkId,
    });
    expect(pending.state).toBe("pending");
    expect(first.acceptSteeringInput("followup-message").state).toBe("accepted");

    const reopened = new StateStore(path);
    expect(reopened.getSteeringInput("followup-message")?.sdkMessageId).toBe(initialSdkId);
    const editedSdkId = crypto.randomUUID();
    const edited = reopened.updateSteeringInput("followup-message", "수정 지시", editedSdkId);
    expect(edited).toMatchObject({ content: "수정 지시", sdkMessageId: editedSdkId, state: "edited" });
    const deletedSdkId = crypto.randomUUID();
    const deleted = reopened.deleteSteeringInput("followup-message", deletedSdkId);
    expect(deleted).toMatchObject({ sdkMessageId: deletedSdkId, state: "deleted" });
    expect(deleted?.deletedAt).not.toBeNull();
    expect(reopened.listJobSteeringInputs(job.id)).toHaveLength(1);
  });

  test("discards only a pending steering row when actor acceptance fails", () => {
    const db = store();
    const job = db.enqueue(input("steering", "steering:two", "source-message-2"));
    db.beginSteeringInput({
      messageId: "followup-pending",
      jobId: job.id,
      conversationKey: job.conversationKey,
      content: "pending",
      sdkMessageId: crypto.randomUUID(),
    });
    expect(db.discardPendingSteeringInput("followup-pending")).toBe(true);
    expect(db.getSteeringInput("followup-pending")).toBeNull();
  });

  test("deduplicates and reuses durable interaction answers after restart", () => {
    const path = join(tmpdir(), `native-interaction-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const first = new StateStore(path);
    const job = first.enqueue(input("interactive", "interactive:one", "question-message"));
    const interaction = first.beginInteraction(job.id, job.conversationKey, {
      question: "배포할까?",
      choices: ["배포", "중단"],
      requestId: "sdk-request-1",
      kind: "question",
    });
    expect(interaction.status).toBe("pending");
    first.setInteractionMessage(interaction.id, "discord-question-1");
    first.answerInteraction(interaction.id, "배포");
    expect(first.tryAnswerInteraction(interaction.id, "중단")).toBeNull();
    expect(first.getInteraction(interaction.id)?.answer).toBe("배포");

    const reopened = new StateStore(path);
    const replay = reopened.beginInteraction(job.id, job.conversationKey, {
      question: "배포할까?",
      choices: ["배포", "중단"],
      requestId: "sdk-request-1",
      kind: "question",
    });
    expect(replay.id).toBe(interaction.id);
    expect(replay.status).toBe("answered");
    expect(replay.answer).toBe("배포");
    expect(replay.discordMessageId).toBe("discord-question-1");
    expect(reopened.getInteraction(interaction.id)).toEqual(replay);
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
