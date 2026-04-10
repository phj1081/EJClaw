import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createPairedTask } from './db.js';
import {
  executeBotOnlyPairedFollowUpAction,
  executePendingPairedTurn,
} from './message-runtime-flow.js';
import {
  claimPairedTurnExecution,
  resetPairedFollowUpScheduleState,
  schedulePairedFollowUpOnce,
  type ScheduledPairedFollowUpIntentKind,
} from './paired-follow-up-scheduler.js';
import type { PairedTask } from './types.js';

describe('executeBotOnlyPairedFollowUpAction', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
  });

  it('deduplicates bot-only requeue follow-ups within the same run', async () => {
    const task: PairedTask = {
      id: 'task-bot-only-dedup',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    };
    const enqueue = vi.fn();
    const closeStdin = vi.fn();
    const log = {
      info: vi.fn(),
    } as any;
    const schedulePairedFollowUp = (
      scheduledTask: PairedTask,
      intentKind: ScheduledPairedFollowUpIntentKind,
    ) =>
      schedulePairedFollowUpOnce({
        chatJid: 'group@test',
        runId: 'run-bot-only-dedup',
        task: scheduledTask,
        intentKind,
        enqueue,
      });

    const action = {
      kind: 'requeue-pending-turn' as const,
      task,
      cursor: 42,
      cursorKey: 'group@test',
      intentKind: 'owner-follow-up' as const,
      nextRole: 'owner' as const,
    };

    const first = await executeBotOnlyPairedFollowUpAction({
      action,
      chatJid: 'group@test',
      group: {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2026-03-30T00:00:00.000Z',
        requiresTrigger: false,
        agentType: 'codex',
      },
      runId: 'run-bot-only-dedup',
      channel: {} as any,
      log,
      saveState: vi.fn(),
      lastAgentTimestamps: {},
      executeTurn: vi.fn(),
      schedulePairedFollowUp,
      closeStdin,
    });

    const second = await executeBotOnlyPairedFollowUpAction({
      action,
      chatJid: 'group@test',
      group: {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2026-03-30T00:00:00.000Z',
        requiresTrigger: false,
        agentType: 'codex',
      },
      runId: 'run-bot-only-dedup',
      channel: {} as any,
      log,
      saveState: vi.fn(),
      lastAgentTimestamps: {},
      executeTurn: vi.fn(),
      schedulePairedFollowUp,
      closeStdin,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(closeStdin).toHaveBeenCalledTimes(1);
    expect(closeStdin).toHaveBeenCalledWith();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'group@test',
        taskId: 'task-bot-only-dedup',
        taskStatus: 'active',
        handoffMode: 'requeue',
        nextRole: 'owner',
        intentKind: 'owner-follow-up',
        scheduled: false,
      }),
      'Skipped duplicate paired pending turn requeue while task state was unchanged',
    );
  });

  it('skips inline finalize when the same finalize-owner turn revision was already claimed elsewhere', async () => {
    const task: PairedTask = {
      id: 'task-inline-finalize-dedup',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'merge_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:05:00.000Z',
    };
    const executeTurn = vi.fn();
    const log = {
      info: vi.fn(),
    } as any;

    createPairedTask(task as any);

    expect(
      claimPairedTurnExecution({
        chatJid: 'group@test',
        runId: 'run-existing-finalize-owner',
        task,
        intentKind: 'finalize-owner-turn',
      }),
    ).toBe(true);

    const result = await executeBotOnlyPairedFollowUpAction({
      action: {
        kind: 'inline-finalize',
        task,
        cursor: 42,
      },
      chatJid: 'group@test',
      group: {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2026-03-30T00:00:00.000Z',
        requiresTrigger: false,
        agentType: 'codex',
      },
      runId: 'run-inline-finalize',
      channel: {} as any,
      log,
      saveState: vi.fn(),
      lastAgentTimestamps: {},
      executeTurn,
      schedulePairedFollowUp: vi.fn(() => true),
      closeStdin: vi.fn(),
    });

    expect(result).toBe(true);
    expect(executeTurn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'group@test',
        taskId: 'task-inline-finalize-dedup',
        taskStatus: 'merge_ready',
        handoffMode: 'inline-finalize',
      }),
      'Skipped inline merge_ready finalize because the task revision was already claimed elsewhere',
    );
  });
});

describe('executePendingPairedTurn', () => {
  it('passes the explicit pending role through as forcedRole', async () => {
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));

    const result = await executePendingPairedTurn({
      pendingTurn: {
        prompt: 'pending owner follow-up',
        channel: {} as any,
        cursor: null,
        taskId: 'task-pending-owner-follow-up',
        taskUpdatedAt: '2026-03-30T00:00:00.000Z',
        intentKind: 'owner-follow-up',
        role: 'owner',
      },
      chatJid: 'group@test',
      group: {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2026-03-30T00:00:00.000Z',
        requiresTrigger: false,
        agentType: 'codex',
      },
      runId: 'run-pending-owner-forced-role',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      saveState: vi.fn(),
      lastAgentTimestamps: {},
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
    });

    expect(result).toBe(true);
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryRole: 'owner',
        forcedRole: 'owner',
        pairedTurnIdentity: {
          turnId:
            'task-pending-owner-follow-up:2026-03-30T00:00:00.000Z:owner-follow-up',
          taskId: 'task-pending-owner-follow-up',
          taskUpdatedAt: '2026-03-30T00:00:00.000Z',
          intentKind: 'owner-follow-up',
          role: 'owner',
        },
      }),
    );
  });
});
