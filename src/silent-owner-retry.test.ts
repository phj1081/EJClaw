import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createPairedTask,
  getPairedTaskById,
} from './db.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';
import { runQueuedGroupTurn } from './message-runtime-queue.js';
import {
  resolveNextTurnAction,
  resolveQueuedPairedTurnRole,
} from './message-runtime-rules.js';
import {
  resetPairedFollowUpScheduleState,
  schedulePairedFollowUpOnce,
} from './paired-follow-up-scheduler.js';
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
    id: 'task-silent-owner-retry',
    chat_jid: 'group@test',
    group_folder: 'test-group',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: null,
    title: null,
    source_ref: 'HEAD',
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 1,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    owner_failure_count: 1,
    created_at: '2026-03-30T00:00:00.000Z',
    updated_at: '2026-03-30T00:00:00.000Z',
    ...overrides,
  };
}

function makeChannel(): Channel {
  return {
    name: 'discord',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

describe('silent owner retry recovery', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
  });

  it('treats Codex selected-model capacity as a rotation trigger', () => {
    expect(
      detectCodexRotationTrigger(
        'Selected model is at capacity. Please try a different model.',
      ),
    ).toEqual({ shouldRotate: true, reason: 'overloaded' });
  });

  it('maps active tasks with a previous silent owner failure to an owner retry', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'active',
        lastTurnOutputRole: null,
        ownerFailureCount: 1,
      }),
    ).toEqual({ kind: 'owner-follow-up' });
    expect(
      resolveQueuedPairedTurnRole({
        taskStatus: 'active',
        hasHumanMessage: false,
        lastTurnOutputRole: null,
        ownerFailureCount: 1,
      }),
    ).toBe('owner');
  });

  it('runs a queued owner retry after a silent owner failure leaves an active task', async () => {
    const task = makeTask();
    createPairedTask(task);
    expect(
      schedulePairedFollowUpOnce({
        chatJid: task.chat_jid,
        runId: 'run-silent-owner-retry-schedule',
        task,
        intentKind: 'owner-follow-up',
        enqueue: vi.fn(),
      }),
    ).toBe(true);
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));

    const outcome = await runQueuedGroupTurn({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-silent-owner-retry',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'bot-silent-owner-retry',
          chat_jid: task.chat_jid,
          sender: 'owner-bot@test',
          sender_name: 'owner',
          content: 'retry owner',
          timestamp: '2026-03-30T00:00:04.000Z',
          seq: 48,
          is_bot_message: true,
        },
      ],
      task: getPairedTaskById(task.id),
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
          turnId:
            'task-silent-owner-retry:2026-03-30T00:00:00.000Z:owner-follow-up',
          taskId: 'task-silent-owner-retry',
          taskUpdatedAt: '2026-03-30T00:00:00.000Z',
          intentKind: 'owner-follow-up',
          role: 'owner',
        },
      }),
    );
  });
});
