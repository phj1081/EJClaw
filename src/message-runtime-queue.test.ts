import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createPairedTask,
  getLatestOpenPairedTaskForChat,
  getPairedTaskById,
  getPairedTurnById,
  insertPairedTurnOutput,
  markPairedTurnRunning,
  updatePairedTaskIfUnchanged,
} from './db.js';
import { claimPairedTurnExecution } from './paired-follow-up-scheduler.js';
import {
  runPendingPairedTurnIfNeeded,
  runQueuedGroupTurn,
} from './message-runtime-queue.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import type { Channel, PairedTask, RegisteredGroup } from './types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: '2026-03-30T00:00:00.000Z',
    requiresTrigger: false,
    agentType: 'codex',
    workDir: '/repo',
  };
}

function makeTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-queue-claim',
    chat_jid: 'group@test',
    group_folder: 'test-group',
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    owner_agent_type: 'claude-code',
    reviewer_agent_type: 'codex',
    arbiter_agent_type: null,
    title: null,
    source_ref: 'HEAD',
    plan_notes: null,
    review_requested_at: '2026-03-30T00:00:00.000Z',
    round_trip_count: 1,
    status: 'review_ready',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-03-30T00:00:00.000Z',
    updated_at: '2026-03-30T00:00:00.000Z',
    ...overrides,
  };
}

function makeChannel(): Channel {
  return {
    name: 'discord-review',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

describe('message-runtime-queue', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
  });

  it('skips a pending paired turn when another run already claimed the same task revision', async () => {
    const task = makeTask();
    createPairedTask(task);

    expect(
      claimPairedTurnExecution({
        chatJid: task.chat_jid,
        runId: 'run-first-claim',
        task,
        intentKind: 'reviewer-turn',
      }),
    ).toBe(true);

    const executeTurn = vi.fn();
    const freshTask = getPairedTaskById(task.id);
    expect(freshTask).toBeDefined();
    const outcome = await runPendingPairedTurnIfNeeded({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-second-claim',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      task: freshTask,
      rawMissedMessages: [
        {
          id: 'bot-follow-up-1',
          chat_jid: task.chat_jid,
          sender: 'reviewer@test',
          sender_name: 'reviewer',
          content: 'review pending',
          seq: 42,
          timestamp: '2026-03-30T00:00:01.000Z',
        },
      ],
      saveState: vi.fn(),
      lastAgentTimestamps: {},
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
      roleToChannel: {
        owner: null,
        reviewer: makeChannel(),
        arbiter: null,
      },
      labelPairedSenders: (_chatJid, messages) => messages,
      mode: 'idle',
    });

    expect(outcome).toBe(true);
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('skips a queued owner turn while a reviewer execution lease is still active after a fresh refetch', async () => {
    const task = makeTask();
    createPairedTask(task);

    const reviewerClaim = claimPairedTurnExecution({
      chatJid: task.chat_jid,
      runId: 'run-first-reviewer-claim',
      task,
      intentKind: 'reviewer-turn',
    });
    expect(reviewerClaim).toBe(true);

    const reviewTask = getPairedTaskById(task.id);
    expect(reviewTask).toBeDefined();
    const reviewerStartedAt = '2026-03-30T00:00:03.000Z';
    expect(
      updatePairedTaskIfUnchanged(reviewTask!.id, reviewTask!.updated_at, {
        status: 'in_review',
        updated_at: reviewerStartedAt,
      }),
    ).toBe(true);

    const freshTask = getPairedTaskById(task.id);
    expect(freshTask?.status).toBe('in_review');

    const executeTurn = vi.fn();
    const outcome = await runQueuedGroupTurn({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-second-owner-claim',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'human-1',
          chat_jid: task.chat_jid,
          sender: 'user@test',
          sender_name: 'User',
          content: '다시 수정해줘',
          timestamp: '2026-03-30T00:00:02.000Z',
          seq: 43,
          is_bot_message: false,
        },
      ],
      task: freshTask,
      roleToChannel: {
        owner: null,
        reviewer: makeChannel(),
        arbiter: null,
      },
      ownerChannel: makeChannel(),
      lastAgentTimestamps: {},
      saveState: vi.fn(),
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
      labelPairedSenders: (_chatJid, messages) => messages,
      formatMessages: () => 'formatted prompt',
    });

    expect(outcome).toBe(true);
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('skips a queued reviewer rerun when the latest persisted turn already belongs to the reviewer', async () => {
    const task = makeTask();
    createPairedTask(task);
    insertPairedTurnOutput(task.id, 1, 'reviewer', 'DONE\nreview finished');

    const executeTurn = vi.fn();
    const outcome = await runQueuedGroupTurn({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-stale-reviewer-rerun',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'bot-1',
          chat_jid: task.chat_jid,
          sender: 'reviewer-bot@test',
          sender_name: 'reviewer',
          content: '추가 상태 메시지',
          timestamp: '2026-03-30T00:00:02.000Z',
          seq: 44,
          is_bot_message: true,
        },
      ],
      task,
      roleToChannel: {
        owner: null,
        reviewer: makeChannel(),
        arbiter: null,
      },
      ownerChannel: makeChannel(),
      lastAgentTimestamps: {},
      saveState: vi.fn(),
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
      labelPairedSenders: (_chatJid, messages) => messages,
      formatMessages: () => 'formatted prompt',
    });

    expect(outcome).toBe(true);
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('always passes the explicit reviewer role for queued paired reviewer turns', async () => {
    const task = makeTask();
    createPairedTask(task);
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));

    const outcome = await runQueuedGroupTurn({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-reviewer-forced-role',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'bot-reviewer-1',
          chat_jid: task.chat_jid,
          sender: 'reviewer-bot@test',
          sender_name: 'reviewer',
          content: 'review pending',
          timestamp: '2026-03-30T00:00:02.000Z',
          seq: 45,
          is_bot_message: true,
        },
      ],
      task,
      roleToChannel: {
        owner: null,
        reviewer: makeChannel(),
        arbiter: null,
      },
      ownerChannel: makeChannel(),
      lastAgentTimestamps: {},
      saveState: vi.fn(),
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
      labelPairedSenders: (_chatJid, messages) => messages,
      formatMessages: () => 'formatted prompt',
    });

    expect(outcome).toBe(true);
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryRole: 'reviewer',
        forcedRole: 'reviewer',
        pairedTurnIdentity: {
          turnId: 'task-queue-claim:2026-03-30T00:00:00.000Z:reviewer-turn',
          taskId: 'task-queue-claim',
          taskUpdatedAt: '2026-03-30T00:00:00.000Z',
          intentKind: 'reviewer-turn',
          role: 'reviewer',
        },
      }),
    );
  });

  it('always passes the explicit owner role for queued paired owner turns', async () => {
    const task = makeTask({
      status: 'active',
      review_requested_at: null,
    });
    createPairedTask(task);
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));

    const outcome = await runQueuedGroupTurn({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-owner-forced-role',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'human-owner-1',
          chat_jid: task.chat_jid,
          sender: 'user@test',
          sender_name: 'User',
          content: '다시 고쳐줘',
          timestamp: '2026-03-30T00:00:03.000Z',
          seq: 46,
          is_bot_message: false,
        },
      ],
      task,
      roleToChannel: {
        owner: null,
        reviewer: makeChannel(),
        arbiter: null,
      },
      ownerChannel: makeChannel(),
      lastAgentTimestamps: {},
      saveState: vi.fn(),
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
      labelPairedSenders: (_chatJid, messages) => messages,
      formatMessages: () => 'formatted prompt',
    });

    expect(outcome).toBe(true);
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryRole: 'owner',
        forcedRole: 'owner',
        pairedTurnIdentity: {
          turnId: 'task-queue-claim:2026-03-30T00:00:00.000Z:owner-turn',
          taskId: 'task-queue-claim',
          taskUpdatedAt: '2026-03-30T00:00:00.000Z',
          intentKind: 'owner-turn',
          role: 'owner',
        },
      }),
    );
  });

  it('splits merge_ready owner turns into a fresh task and cancels the stale finalize turn', async () => {
    const task = makeTask({
      id: 'task-merge-ready-owner',
      status: 'merge_ready',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    createPairedTask(task);
    insertPairedTurnOutput(task.id, 1, 'reviewer', 'DONE\nreview finished');
    const staleFinalizeTurn = buildPairedTurnIdentity({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      intentKind: 'finalize-owner-turn',
      role: 'owner',
    });
    markPairedTurnRunning({
      turnIdentity: staleFinalizeTurn,
      executorServiceId: 'claude',
      executorAgentType: 'claude-code',
      runId: 'run-stale-finalize',
    });
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));

    const outcome = await runQueuedGroupTurn({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-owner-after-merge-ready',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'human-merge-ready-1',
          chat_jid: task.chat_jid,
          sender: 'user@test',
          sender_name: 'User',
          content: '새 질문입니다',
          timestamp: '2026-03-30T00:00:02.000Z',
          seq: 47,
          is_bot_message: false,
        },
      ],
      task,
      roleToChannel: {
        owner: null,
        reviewer: makeChannel(),
        arbiter: null,
      },
      ownerChannel: makeChannel(),
      lastAgentTimestamps: {},
      saveState: vi.fn(),
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
      labelPairedSenders: (_chatJid, messages) => messages,
      formatMessages: () => 'formatted prompt',
    });

    expect(outcome).toBe(true);
    const freshTask = getLatestOpenPairedTaskForChat(task.chat_jid);
    expect(freshTask).toBeDefined();
    expect(freshTask?.id).not.toBe(task.id);
    expect(getPairedTaskById(task.id)).toMatchObject({
      status: 'completed',
      completion_reason: 'superseded',
    });
    expect(getPairedTurnById(staleFinalizeTurn.turnId)).toMatchObject({
      state: 'cancelled',
    });
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('DONE\nreview finished'),
        deliveryRole: 'owner',
        forcedRole: 'owner',
        pairedTurnIdentity: expect.objectContaining({
          taskId: freshTask?.id,
          intentKind: 'owner-turn',
          role: 'owner',
        }),
      }),
    );
  });
});
