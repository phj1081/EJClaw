import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
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
  test("runs different conversations in one route concurrently but serializes one conversation", () => {
    const db = store();
    db.enqueue(input("cleanapo", "cleanapo:one", "m1"));
    db.enqueue(input("cleanapo", "cleanapo:two", "m2"));
    db.enqueue(input("cleanapo", "cleanapo:one", "m3"));

    const first = db.claimNext(2);
    expect(first?.routeId).toBe("cleanapo");
    const second = db.claimNext(2);
    expect(second?.routeId).toBe("cleanapo");
    expect(new Set([first?.conversationKey, second?.conversationKey])).toEqual(
      new Set(["cleanapo:one", "cleanapo:two"]),
    );
    expect(db.claimNext(2)).toBeNull();
  });

  test("keeps an explicit shared lock available for routes that opt out of conversation worktrees", () => {
    const db = store();
    db.enqueue({ ...input("legacy", "legacy:one", "legacy-1"), lockKey: "legacy-shared" });
    db.enqueue({ ...input("legacy", "legacy:two", "legacy-2"), lockKey: "legacy-shared" });

    expect(db.claimNext(2)?.messageId).toBe("legacy-1");
    expect(db.claimNext(2)).toBeNull();
  });

  test("migrates only queued jobs from a legacy route lock", () => {
    const db = store();
    const running = db.enqueue({ ...input("cleanapo", "cleanapo:one", "legacy-running"), lockKey: "cleanapo" });
    const queued = db.enqueue({ ...input("cleanapo", "cleanapo:two", "legacy-queued"), lockKey: "cleanapo" });
    db.claimNext(2);

    expect(db.setQueuedLock(running.id, running.conversationKey)).toBe(false);
    expect(db.setQueuedLock(queued.id, queued.conversationKey)).toBe(true);
    expect(db.getJob(running.id)?.lockKey).toBe("cleanapo");
    expect(db.getJob(queued.id)?.lockKey).toBe("cleanapo:two");
  });

  test("atomically migrates active watcher locks with queued jobs", () => {
    const db = store();
    const conversationKey = "cleanapo:watch-thread";
    const origin = db.enqueue({ ...input("cleanapo", conversationKey, "watch-origin"), lockKey: "cleanapo" });
    db.cancelJob(origin.id, "seed watch");
    db.upsertPullRequestWatch(
      { ...origin, lockKey: "cleanapo" },
      { repo: "owner/repo", number: 17, url: "https://github.com/owner/repo/pull/17" },
    );
    const normal = db.enqueue({ ...input("cleanapo", conversationKey, "normal-thread-job"), lockKey: conversationKey });

    expect(db.migrateConversationLocks((_routeId, key) => key)).toEqual({ jobs: 0, watches: 1 });
    const watch = db.listActivePullRequestWatches()[0]!;
    expect(watch.lockKey).toBe(conversationKey);
    db.enqueue({
      ...input("cleanapo", conversationKey, "watch-wake"),
      lockKey: watch.lockKey,
      sessionId: watch.sessionId,
      pinnedSession: true,
    });

    expect(db.claimNext(2)?.id).toBe(normal.id);
    expect(db.claimNext(2)).toBeNull();
  });

  test("holds a queued job until the durable progress card is acknowledged", () => {
    const db = store();
    const queued = db.enqueue({
      ...input("cleanapo", "cleanapo:queued", "queued-card"),
      holdForProgress: true,
    });

    expect(queued.progressPending).toBe(true);
    expect(db.hasRunnable()).toBe(false);
    expect(db.claimNext(1)).toBeNull();
    expect(db.acknowledgeQueuedProgress(queued.id, "discord-progress", "⏳ 대기 중")).toBe(true);

    expect(db.getJob(queued.id)).toMatchObject({
      status: "queued",
      progressMessageId: "discord-progress",
      progressText: "⏳ 대기 중",
      progressPending: false,
    });
    expect(db.claimNext(1)?.id).toBe(queued.id);
  });

  test("supports an explicit release only after progress is known by another durable path", () => {
    const db = store();
    const queued = db.enqueue({
      ...input("cleanapo", "cleanapo:queued-fallback", "queued-fallback"),
      holdForProgress: true,
    });
    expect(db.releaseProgressHold(queued.id)).toBe(false);
    expect(db.setProgress(queued.id, "known-progress", "⏳ 대기 중")).toBe(true);
    expect(db.releaseProgressHold(queued.id)).toBe(true);
    expect(db.releaseProgressHold(queued.id)).toBe(false);
    expect(db.claimNext(1)?.id).toBe(queued.id);
  });

  test("rejects a delayed progress ACK after cancellation", () => {
    const db = store();
    const queued = db.enqueue({
      ...input("cleanapo", "cleanapo:queued-cancel", "queued-cancel"),
      holdForProgress: true,
    });
    expect(db.cancelJob(queued.id, "cancel during Discord send")?.status).toBe("cancelled");
    expect(db.acknowledgeQueuedProgress(queued.id, "orphan-card", "⏳ 대기 중")).toBe(false);
    expect(db.setProgress(queued.id, "orphan-card", "⏳ 대기 중")).toBe(false);
    expect(db.getJob(queued.id)?.progressMessageId).toBeNull();
  });

  test("protects a prepared workspace before SDK init without binding the session", () => {
    const db = store();
    const job = db.enqueue(input("cleanapo", "cleanapo:prepared", "prepared-workspace"));
    expect(db.claimNext(1)?.id).toBe(job.id);
    expect(db.bindPreparedWorkspace(job.id, "/tmp/prepared-workspace")).toBe(true);
    expect(db.getJob(job.id)?.workspacePath).toBe("/tmp/prepared-workspace");
    expect(db.activeWorkspacePaths()).toContain("/tmp/prepared-workspace");
    expect(db.sessionWorkspaceForSession(job.conversationKey, job.sessionId)).toBeNull();
  });

  test("tracks the workspace bound to a conversation session", () => {
    const db = store();
    db.enqueue(input("cleanapo", "cleanapo:workspace", "workspace-message"));

    expect(db.sessionWorkspace("cleanapo:workspace")).toBeNull();
    db.setSessionWorkspace("cleanapo:workspace", "/tmp/worktree-a");
    expect(db.sessionWorkspace("cleanapo:workspace")).toBe("/tmp/worktree-a");
  });

  test("adds workspace binding to an existing sessions schema", () => {
    const path = join(tmpdir(), `native-legacy-session-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (
        conversation_key TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        has_history INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const migrated = new StateStore(path);
    const inspected = new Database(path, { readonly: true });
    const columns = inspected
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((column: { name: string }) => column.name);
    expect(columns).toContain("workspace_path");
    inspected.close();
    migrated.close();
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

  test("requeues a terminal durable notice with the same deterministic message id", () => {
    const db = store();
    const job = db.enqueue(input("notice", "notice:one", "cohort-notice"));
    db.cancelByMessageId("cohort-notice", "simulated delivery failure");
    expect(db.getJob(job.id)?.status).toBe("cancelled");

    const replay = db.requeueTerminalByMessageId(
      "cohort-notice",
      "durable notice replay",
      "new notice",
      "notice:conversation-lock",
    );
    expect(replay?.id).toBe(job.id);
    expect(replay?.status).toBe("queued");
    expect(replay?.lockKey).toBe("notice:conversation-lock");
    expect(replay?.prompt).toBe("new notice");
    expect(replay?.attempts).toBe(0);
    expect(replay?.error).toBeNull();
  });

  test("persists final chunks, cursor and accepted message ids across restarts", () => {
    const db = store();
    const job = db.enqueue(input("delivery", "delivery:one", "delivery-message"));
    expect(db.claimNext(1)?.id).toBe(job.id);
    db.stageDelivery(
      job.id,
      { ok: true, result: "done", sessionId: job.sessionId, stderr: "", exitCode: 0 },
      "completed",
    );

    const files = [{ path: "/tmp/result.png", name: "result.png" }];
    expect(db.prepareDelivery(job.id, ["one", "two"], files)).toEqual({
      chunks: ["one", "two"],
      cursor: 0,
      messageIds: [],
      files,
    });
    expect(db.markDeliveryChunk(job.id, 0, "discord-1")).toBe(true);

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

  test("rejects final delivery ACKs after cancellation wins", () => {
    const db = store();
    const job = db.enqueue(input("delivery", "delivery:cancel-race", "delivery-cancel-race"));
    expect(db.claimNext(1)?.id).toBe(job.id);
    db.stageDelivery(
      job.id,
      { ok: true, result: "done", sessionId: job.sessionId, stderr: "", exitCode: 0 },
      "completed",
    );
    db.prepareDelivery(job.id, ["one"], []);
    expect(db.cancelJob(job.id, "cancel won")?.status).toBe("cancelled");
    expect(db.markDeliveryChunk(job.id, 0, "late-final")).toBe(false);
    expect(db.getJob(job.id)?.deliveryCursor).toBe(0);
  });

  test("updates queued source messages but never rewrites an active execution", () => {
    const db = store();
    const queued = db.enqueue(input("cleanapo", "cleanapo:edit", "editable"));
    expect(db.updateQueuedPrompt("editable", "수정된 요청")?.prompt).toBe("수정된 요청");
    db.claimNext(1);
    expect(db.updateQueuedPrompt("editable", "늦은 수정")).toBeNull();
    expect(db.getJob(queued.id)?.prompt).toBe("수정된 요청");
  });

  test("orphans stale pending questions owned by terminal jobs during startup migration", () => {
    const db = store();
    const job = db.enqueue(input("terminal", "terminal:question", "terminal-question"));
    expect(db.claimNext(1)?.id).toBe(job.id);
    const interaction = db.beginInteraction(job.id, job.conversationKey, {
      question: "계속할까?",
      choices: ["예", "아니오"],
      requestId: "terminal-question",
    });
    db.setInteractionMessage(interaction.id, "1527240000000000200");
    db.stageDelivery(
      job.id,
      { ok: true, result: "done", sessionId: job.sessionId, stderr: "", exitCode: 0 },
      "completed",
    );
    db.markDelivered(job.id);

    expect(db.orphanPendingInteractionsForTerminalJobs()).toBe(1);
    expect(db.getInteraction(interaction.id)?.status).toBe("orphaned");
    expect(db.listSettledInteractionsWithMessages().map((record) => record.id)).toEqual([interaction.id]);
    expect(db.orphanPendingInteractionsForTerminalJobs()).toBe(0);
  });

  test("cancels a queued or running job and orphans its pending interaction when the source is deleted", () => {
    const db = store();
    const job = db.enqueue(input("cleanapo", "cleanapo:delete", "deletable"));
    const interaction = db.beginInteraction(job.id, job.conversationKey, {
      question: "계속?",
      choices: ["예", "아니오"],
      requestId: "delete-question",
    });
    db.setInteractionMessage(interaction.id, "discord-delete-question");

    expect(db.cancelByMessageId("deletable")?.id).toBe(job.id);
    expect(db.getJob(job.id)?.status).toBe("cancelled");
    expect(db.getInteraction(interaction.id)?.status).toBe("orphaned");
    expect(db.tryAnswerInteraction(interaction.id, "예")).toBeNull();
    expect(() => db.answerInteraction(interaction.id, "예")).toThrow("interaction is not pending");
    expect(db.listSettledInteractionsWithMessages().map((record) => record.id)).toEqual([interaction.id]);
    const settled = db.markInteractionCardSettled(interaction.id, "discord-delete-question");
    expect(settled?.discordSettledAt).not.toBeNull();
    expect(db.listSettledInteractionsWithMessages()).toEqual([]);
    expect(db.listSettledInteractionsWithoutMessages()).toEqual([]);
    expect(db.markInteractionCardSettled(interaction.id, "discord-delete-question")).toBeNull();
    expect(db.cancelByMessageId("deletable")).toBeNull();
  });

  test("conversation cancellation orphans pending questions for every cancelled job", () => {
    const db = store();
    const first = db.enqueue(input("cancel", "cancel:thread", "cancel-1"));
    const second = db.enqueue(input("cancel", "cancel:thread", "cancel-2"));
    const firstQuestion = db.beginInteraction(first.id, first.conversationKey, {
      question: "첫째?",
      choices: ["예"],
      requestId: "cancel-question-1",
    });
    const secondQuestion = db.beginInteraction(second.id, second.conversationKey, {
      question: "둘째?",
      choices: ["예"],
      requestId: "cancel-question-2",
    });
    expect(db.cancelByConversation(first.conversationKey)).toHaveLength(2);
    expect(db.getInteraction(firstQuestion.id)?.status).toBe("orphaned");
    expect(db.getInteraction(secondQuestion.id)?.status).toBe("orphaned");
  });

  test("reconciles legacy text steering into a pending question answer without duplicate recovery steering", () => {
    const db = store();
    const job = db.enqueue(input("question", "question:thread", "question-source"));
    db.claimNext(1);
    const interaction = db.beginInteraction(job.id, job.conversationKey, {
      question: "어떤 방식으로 진행할까?",
      choices: ["증거 제공", "코드 하드닝"],
      requestId: "legacy-text-question",
      kind: "question",
    });
    db.beginSteeringInput({
      messageId: "legacy-text-answer",
      jobId: job.id,
      conversationKey: job.conversationKey,
      content: "수정 가능하면 바로 수정해줘",
      sdkMessageId: "legacy-sdk-answer",
    });
    db.acceptSteeringInput("legacy-text-answer");

    expect(db.reconcilePendingInteractionSteering()).toBe(1);
    expect(db.getInteraction(interaction.id)).toMatchObject({
      status: "answered",
      answer: "수정 가능하면 바로 수정해줘",
    });
    expect(db.getSteeringInput("legacy-text-answer")).toBeNull();
    expect(db.listSettledInteractionsWithoutMessages().map((record) => record.id)).toContain(interaction.id);
    expect(db.listRecoverySteeringInputs(job.id)).toEqual([]);
    expect(db.reconcilePendingInteractionSteering()).toBe(0);
  });

  test("never consumes steering that was accepted before the question event", () => {
    const db = store();
    const queued = db.enqueue(input("legacy", "legacy:pre-question", "pre-question"));
    expect(db.claimNext(1)?.id).toBe(queued.id);
    db.beginSteeringInput({
      messageId: "1527240000000000001",
      jobId: queued.id,
      conversationKey: queued.conversationKey,
      content: "질문 전 지시",
      sdkMessageId: "sdk-pre-question",
    });
    db.acceptSteeringInput("1527240000000000001");
    const interaction = db.beginInteraction(queued.id, queued.conversationKey, {
      question: "계속할까?",
      choices: ["예", "아니오"],
      requestId: "after-steering",
    });
    db.setInteractionMessage(interaction.id, "1527240000000000002");

    expect(db.reconcilePendingInteractionSteering()).toBe(0);
    expect(db.getInteraction(interaction.id)?.status).toBe("pending");
    expect(db.getSteeringInput("1527240000000000001")?.state).toBe("accepted");
  });

  test("reconciles sequence-less rows with author provenance only when Discord snowflakes prove ordering", () => {
    const path = join(tmpdir(), `native-state-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const seeded = new StateStore(path);
    const queued = seeded.enqueue(input("legacy", "legacy:snowflake-order", "legacy-snowflake-order"));
    expect(seeded.claimNext(1)?.id).toBe(queued.id);
    const interaction = seeded.beginInteraction(queued.id, queued.conversationKey, {
      question: "언제 진행할까?",
      choices: [],
      requestId: "legacy-snowflake",
    });
    seeded.setInteractionMessage(interaction.id, "1527240000000000100");
    seeded.beginSteeringInput({
      messageId: "1527240000000000101",
      jobId: queued.id,
      conversationKey: queued.conversationKey,
      content: "지금",
      sdkMessageId: "legacy-sdk-answer",
    });
    seeded.acceptSteeringInput("1527240000000000101");
    seeded.close();

    const legacy = new Database(path);
    legacy.query("UPDATE interactions SET event_sequence=NULL, created_at=? WHERE id=?").run(
      "2026-07-16T00:00:00.000Z",
      interaction.id,
    );
    legacy.query("UPDATE steering_inputs SET event_sequence=NULL, created_at=? WHERE message_id=?").run(
      "2026-07-16T00:00:00.000Z",
      "1527240000000000101",
    );
    legacy.close();

    const reopened = new StateStore(path);
    expect(reopened.reconcilePendingInteractionSteering()).toBe(1);
    expect(reopened.getInteraction(interaction.id)?.answer).toBe("지금");
    expect(reopened.getSteeringInput("1527240000000000101")).toBeNull();
    reopened.close();
  });

  test("never reconciles a normal legacy steering row without author provenance", () => {
    const path = join(tmpdir(), `native-state-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const seeded = new StateStore(path);
    const queued = seeded.enqueue(input("legacy", "legacy:missing-author", "legacy-missing-author"));
    expect(seeded.claimNext(1)?.id).toBe(queued.id);
    const interaction = seeded.beginInteraction(queued.id, queued.conversationKey, {
      question: "어떻게 진행할까?",
      choices: [],
      requestId: "legacy-missing-author",
    });
    seeded.setInteractionMessage(interaction.id, "1527240000000000200");
    seeded.beginSteeringInput({
      messageId: "1527240000000000201",
      jobId: queued.id,
      conversationKey: queued.conversationKey,
      content: "지금 진행",
      sdkMessageId: "legacy-missing-author-sdk",
    });
    seeded.acceptSteeringInput("1527240000000000201");
    seeded.close();

    const legacy = new Database(path);
    legacy.query("UPDATE interactions SET event_sequence=NULL WHERE id=?").run(interaction.id);
    legacy.query("UPDATE steering_inputs SET event_sequence=NULL, author_id=NULL WHERE message_id=?")
      .run("1527240000000000201");
    legacy.close();

    const reopened = new StateStore(path);
    expect(reopened.reconcilePendingInteractionSteering()).toBe(0);
    expect(reopened.getInteraction(interaction.id)?.status).toBe("pending");
    expect(reopened.getSteeringInput("1527240000000000201")?.state).toBe("accepted");
    reopened.close();
  });

  test("never reconciles steering text into a permission approval", () => {
    const db = store();
    const job = db.enqueue(input("permission", "permission:thread", "permission-source"));
    db.claimNext(1);
    const interaction = db.beginInteraction(job.id, job.conversationKey, {
      question: "Bash를 허용할까?",
      choices: ["이번만 허용", "거부"],
      requestId: "legacy-permission-question",
      kind: "permission",
    });
    db.beginSteeringInput({
      messageId: "unsafe-text-answer",
      jobId: job.id,
      conversationKey: job.conversationKey,
      content: "이번만 허용",
      sdkMessageId: "unsafe-sdk-answer",
    });
    db.acceptSteeringInput("unsafe-text-answer");

    expect(db.reconcilePendingInteractionSteering()).toBe(0);
    expect(db.getInteraction(interaction.id)?.status).toBe("pending");
    expect(db.getSteeringInput("unsafe-text-answer")).not.toBeNull();
  });

  test("blocks job claims behind a durable conversation gate", () => {
    const db = store();
    const conversationKey = "cleanapo:rewind-gate";
    expect(db.acquireConversationGate(conversationKey, "rewind:op-1")).toBe(true);
    expect(db.hasConversationGate(conversationKey)).toBe(true);
    const gated = db.enqueue(input("cleanapo", conversationKey, "gated-job"));
    expect(db.hasRunnable()).toBe(false);
    expect(db.claimNext(1)).toBeNull();
    expect(db.acquireConversationGate(conversationKey, "rewind:op-2")).toBe(false);
    expect(db.releaseConversationGate(conversationKey, "rewind:op-1")).toBe(true);
    expect(db.claimNext(1)?.id).toBe(gated.id);
    expect(db.acquireConversationGate(conversationKey, "rewind:op-3")).toBe(false);
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
    db.setSessionWorkspace(original.conversationKey, "/tmp/original-workspace");
    const forkedSessionId = crypto.randomUUID();
    db.stageDelivery(
      running.id,
      { ok: true, result: "forked", sessionId: forkedSessionId, stderr: "", exitCode: 0 },
      "completed",
      "/tmp/forked-workspace",
    );
    const branches = db.listSessionBranches(original.conversationKey);
    expect(branches.map((branch) => branch.sessionId).sort()).toEqual([original.sessionId, forkedSessionId].sort());
    expect(branches.find((branch) => branch.sessionId === forkedSessionId)).toMatchObject({
      status: "active",
      workspacePath: "/tmp/forked-workspace",
    });

    db.useSessionBranch(original.conversationKey, original.sessionId.slice(0, 8));
    expect(db.sessionWorkspace(original.conversationKey)).toBe("/tmp/original-workspace");
    const followup = db.enqueue(input("branches", "branches:one", "branch-followup"));
    expect(followup.sessionId).toBe(original.sessionId);
  });

  test("hands the current workspace to an explicit fork while preserving the source revision", () => {
    const db = store();
    const original = db.enqueue(input("branches", "branches:isolated", "branch-isolated"));
    const running = db.claimNext(1)!;
    const workspace = "/tmp/managed-branch-workspace";
    const revision = "3333333333333333333333333333333333333333";
    db.setSessionWorkspace(original.conversationKey, workspace);
    expect(db.setSessionBranchRevision(original.conversationKey, original.sessionId, revision)).toBe(true);
    const forkedSessionId = crypto.randomUUID();
    db.establishExecutionSession(running.id, forkedSessionId, workspace, true);

    const source = db.sessionBranchForSession(original.conversationKey, original.sessionId);
    const forked = db.sessionBranchForSession(original.conversationKey, forkedSessionId);
    expect(source).toMatchObject({ status: "archived", workspacePath: null, workspaceRevision: revision });
    expect(forked).toMatchObject({ status: "active", workspacePath: workspace, workspaceRevision: null });

    db.useSessionBranch(original.conversationKey, original.sessionId.slice(0, 8));
    expect(db.sessionWorkspace(original.conversationKey)).toBeNull();
    expect(db.enqueue(input("branches", original.conversationKey, "branch-isolated-followup")).sessionId)
      .toBe(original.sessionId);
  });

  test("uses a pinned historical session without changing the active conversation pointer", () => {
    const db = store();
    const original = db.enqueue(input("watch", "watch:thread", "origin"));
    const originalRun = db.claimNext(1)!;
    db.stageDelivery(
      originalRun.id,
      { ok: true, result: "origin done", sessionId: original.sessionId, stderr: "", exitCode: 0 },
      "completed",
    );
    const resetSession = db.resetSession(original.conversationKey);
    const pinned = db.enqueue({
      ...input("watch", original.conversationKey, "watch-wake"),
      sessionId: original.sessionId,
      pinnedSession: true,
    });
    const pinnedRun = db.claimNext(1)!;
    expect(pinnedRun.id).toBe(pinned.id);
    db.stageDelivery(
      pinnedRun.id,
      { ok: true, result: "watch done", sessionId: original.sessionId, stderr: "", exitCode: 0 },
      "completed",
    );
    const normalAfterWatch = db.enqueue(input("watch", original.conversationKey, "normal-after-watch"));
    expect(normalAfterWatch.sessionId).toBe(resetSession);
    expect(db.listSessionBranches(original.conversationKey).find((branch) => branch.sessionId === resetSession)?.status)
      .toBe("active");
    db.cancelByMessageId(normalAfterWatch.messageId, "test cleanup");

    const retryPinned = db.enqueue({
      ...input("watch", original.conversationKey, "watch-retry"),
      sessionId: original.sessionId,
      pinnedSession: true,
    });
    const retryRun = db.claimNext(1)!;
    expect(retryRun.id).toBe(retryPinned.id);
    db.retryOrFail(
      retryRun.id,
      { ok: false, result: "retry", sessionId: original.sessionId, stderr: "failed", exitCode: 1 },
      2,
    );
    expect(db.enqueue(input("watch", original.conversationKey, "normal-after-retry")).sessionId).toBe(resetSession);
  });

  test("rejects an empty pinned session and closes migrated active watches without provenance", () => {
    const db = store();
    expect(() => db.enqueue({
      ...input("watch", "watch:empty", "empty-pin"),
      sessionId: "",
      pinnedSession: true,
    })).toThrow("pinned session id is required");
    db.close();

    const path = join(tmpdir(), `native-legacy-watch-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE pull_request_watches(
        id TEXT PRIMARY KEY, route_id TEXT NOT NULL, lock_key TEXT NOT NULL,
        conversation_key TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT,
        author_id TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, url TEXT NOT NULL,
        status TEXT NOT NULL, last_observed_signal TEXT, last_wake_signal TEXT, active_job_id TEXT,
        wake_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, completed_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repo, pr_number)
      );
      INSERT INTO pull_request_watches VALUES(
        'legacy','watch','watch','watch:legacy','channel',NULL,'owner','owner/repo',1,
        'https://github.com/owner/repo/pull/1','active',NULL,NULL,NULL,0,
        '2099-01-01T00:00:00.000Z',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();
    const migrated = new StateStore(path);
    expect(migrated.listActivePullRequestWatches()).toHaveLength(0);
    migrated.close();
    const inspected = new Database(path, { readonly: true });
    expect(inspected.query<{ status: string; completed_reason: string }, []>(
      "SELECT status,completed_reason FROM pull_request_watches WHERE id='legacy'",
    ).get()).toEqual({ status: "completed", completed_reason: "legacy-missing-session" });
    inspected.close();

    const legacyJobPath = join(tmpdir(), `native-legacy-watch-job-${crypto.randomUUID()}.sqlite`);
    paths.push(legacyJobPath);
    const seeded = new StateStore(legacyJobPath);
    const legacyJobs = ["queued", "running", "delivering"].map((status) =>
      seeded.enqueue(input("watch", `watch:legacy:${status}`, `github-watch:legacy:${status}`)));
    seeded.close();
    const legacyJobDb = new Database(legacyJobPath);
    for (const [index, status] of ["queued", "running", "delivering"].entries()) {
      legacyJobDb.query("UPDATE jobs SET status=? WHERE id=?").run(status, legacyJobs[index]!.id);
    }
    legacyJobDb.exec(`
      ALTER TABLE jobs DROP COLUMN pinned_session;
      ALTER TABLE jobs DROP COLUMN github_watch_repo;
      ALTER TABLE jobs DROP COLUMN github_watch_number;
      ALTER TABLE jobs DROP COLUMN expected_head_sha;
    `);
    legacyJobDb.close();

    const migratedJobs = new StateStore(legacyJobPath);
    for (const job of legacyJobs) {
      expect(migratedJobs.getJob(job.id)?.status).toBe("cancelled");
      expect(migratedJobs.getJob(job.id)?.error).toContain("legacy watcher job missing provenance");
    }
    const pointerCheck = new Database(legacyJobPath, { readonly: true });
    for (const job of legacyJobs) {
      const pointer = pointerCheck.query<{ session_id: string; has_history: number }, [string]>(
        "SELECT session_id,has_history FROM sessions WHERE conversation_key=?",
      ).get(job.conversationKey);
      expect(pointer?.session_id).not.toBe(job.sessionId);
      expect(pointer?.has_history).toBe(0);
      expect(pointerCheck.query<{ status: string }, [string]>(
        "SELECT status FROM session_branches WHERE session_id=?",
      ).get(job.sessionId)?.status).toBe("archived");
    }
    pointerCheck.close();
    const fresh = migratedJobs.enqueue(input("watch", legacyJobs[2]!.conversationKey, "normal-after-legacy"));
    expect(fresh.sessionId).not.toBe(legacyJobs[2]!.sessionId);
    migratedJobs.close();
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
    }, "/tmp/rewind-workspace");
    expect(db.getRewindOperation(job.conversationKey, operation.id.slice(0, 8))).toMatchObject({
      checkpoint,
      workspacePath: "/tmp/rewind-workspace",
    });
    expect(db.markRewindApplied(operation.id)).toBe(true);
    expect(db.markRewindApplied(operation.id)).toBe(false);
  });

  test("persists a cleanup tombstone before invalidating all workspace provenance", () => {
    const path = join(tmpdir(), `native-cleanup-tombstone-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const workspacePath = "/tmp/managed-conversation-workspace";
    const first = new StateStore(path);
    const queued = first.enqueue(input("cleanup", "cleanup:one", "cleanup-message"));
    const running = first.claimNext(1)!;
    first.establishExecutionSession(running.id, queued.sessionId, workspacePath);
    const checkpoint = crypto.randomUUID();
    first.recordSessionCheckpoint(running.id, checkpoint);
    const rewind = first.createRewindOperation(
      running.conversationKey,
      queued.sessionId,
      checkpoint,
      { canRewind: true, filesChanged: ["src/a.ts"], insertions: 1, deletions: 0 },
      workspacePath,
    );
    expect(first.activeWorkspacePaths()).toContain(workspacePath);

    first.beginWorkspaceCleanup(workspacePath, "2222222222222222222222222222222222222222");
    expect(first.pendingWorkspaceCleanups()).toEqual([workspacePath]);
    expect(first.getJob(running.id)?.workspacePath).toBeNull();
    expect(first.sessionWorkspace(running.conversationKey)).toBeNull();
    expect(first.listSessionBranches(running.conversationKey)[0]).toMatchObject({
      workspacePath: null,
      workspaceRevision: "2222222222222222222222222222222222222222",
    });
    expect(first.getRewindOperation(running.conversationKey, rewind.id)?.workspacePath).toBeNull();
    first.close();

    const reopened = new StateStore(path);
    expect(reopened.pendingWorkspaceCleanups()).toEqual([workspacePath]);
    expect(reopened.sessionWorkspace(running.conversationKey)).toBeNull();
    reopened.finishWorkspaceCleanup(workspacePath);
    expect(reopened.pendingWorkspaceCleanups()).toEqual([]);
    reopened.close();
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
    expect(edited).toMatchObject({
      content: "수정 지시",
      sdkMessageId: editedSdkId,
      originalSdkMessageId: initialSdkId,
      state: "edited",
    });
    const deletedSdkId = crypto.randomUUID();
    const deleted = reopened.deleteSteeringInput("followup-message", deletedSdkId);
    expect(deleted).toMatchObject({ sdkMessageId: deletedSdkId, state: "deleted" });
    expect(deleted?.deletedAt).not.toBeNull();
    expect(reopened.listJobSteeringInputs(job.id)).toHaveLength(1);
  });

  test("recovers the latest desired state for accepted, edited and deleted steering", () => {
    const db = store();
    const job = db.enqueue(input("steering", "steering:recovery", "source-recovery"));
    for (const [messageId, content] of [
      ["accepted-followup", "수락된 지시"],
      ["edited-followup", "편집 전 지시"],
      ["deleted-followup", "삭제 전 지시"],
    ] as const) {
      db.beginSteeringInput({
        messageId,
        jobId: job.id,
        conversationKey: job.conversationKey,
        content,
        sdkMessageId: crypto.randomUUID(),
      });
      db.acceptSteeringInput(messageId);
    }
    db.updateSteeringInput("edited-followup", "편집된 현재 지시", crypto.randomUUID());
    db.deleteSteeringInput("deleted-followup", crypto.randomUUID());

    expect(db.listRecoverySteeringInputs(job.id).map((record) => [record.messageId, record.state, record.content])).toEqual([
      ["accepted-followup", "accepted", "수락된 지시"],
      ["edited-followup", "edited", "편집된 현재 지시"],
      ["deleted-followup", "deleted", "삭제 전 지시"],
    ]);
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

  test("atomically replaces a pending steering row with a fallback job", () => {
    const db = store();
    const running = db.enqueue(input("steering", "steering:fallback", "source-fallback"));
    db.beginSteeringInput({
      messageId: "fallback-followup",
      jobId: running.id,
      conversationKey: running.conversationKey,
      content: "fallback content",
      sdkMessageId: crypto.randomUUID(),
    });

    const fallback = db.enqueue(
      input("steering", running.conversationKey, "fallback-followup"),
      "fallback-followup",
    );

    expect(fallback.messageId).toBe("fallback-followup");
    expect(db.getSteeringInput("fallback-followup")).toBeNull();
  });

  test("deduplicates and reuses durable interaction answers after restart", () => {
    const path = join(tmpdir(), `native-interaction-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const first = new StateStore(path);
    const job = first.enqueue(input("interactive", "interactive:one", "question-message"));
    first.claimNext(1);
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

  test("atomically persists a marker answer and its exact continuation prompt", () => {
    const db = store();
    const job = db.enqueue(input("interactive", "interactive:marker", "marker-message"));
    db.claimNext(1);
    const interaction = db.beginInteraction(job.id, job.conversationKey, {
      question: "배포할까?",
      choices: ["배포", "중단"],
      requestId: "marker:job:0",
      kind: "question",
      continuation: { sessionId: "marker-session", turn: 1 },
    });

    expect(db.tryAnswerInteraction(interaction.id, "배포")?.answer).toBe("배포");
    expect(db.getJob(job.id)).toMatchObject({
      continuationPrompt: expect.stringContaining("사용자 선택: 배포"),
      continuationSessionId: "marker-session",
      continuationTurn: 1,
    });
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

  test("persists PR watches and resumes the originating Discord conversation", () => {
    const db = store();
    const origin = db.enqueue({
      ...input("eyejokerdb", "eyejokerdb:thread-9", "source-pr"),
      channelId: "channel-9",
      threadId: "thread-9",
      lockKey: "/repo/eyejokerdb",
    });
    const watch = db.upsertPullRequestWatch(origin, {
      repo: "EyeJoker-Internal/eyejokerdb",
      number: 123,
      url: "https://github.com/EyeJoker-Internal/eyejokerdb/pull/123",
    });
    expect(watch).toMatchObject({
      routeId: "eyejokerdb",
      conversationKey: "eyejokerdb:thread-9",
      channelId: "channel-9",
      threadId: "thread-9",
      status: "active",
      wakeCount: 0,
    });
    expect(db.listActivePullRequestWatches()).toHaveLength(1);

    const wake = db.enqueue({
      ...input("eyejokerdb", origin.conversationKey, `github-watch:${watch.id}:signal-1`),
      channelId: watch.channelId,
      threadId: watch.threadId,
      lockKey: watch.lockKey,
      prompt: "fix current-head CI",
    });
    expect(wake.sessionId).toBe(origin.sessionId);
    db.recordPullRequestObservation(watch.id, "signal-1", wake.id);
    expect(db.getPullRequestWatch(watch.id)).toMatchObject({
      lastObservedSignal: "signal-1",
      lastWakeSignal: "signal-1",
      activeJobId: wake.id,
      wakeCount: 1,
    });
    db.completePullRequestWatch(watch.id, "merged");
    expect(db.listActivePullRequestWatches()).toHaveLength(0);
  });
});
