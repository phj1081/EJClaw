import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createPairedTask } from './db.js';
import { runQueuedGroupTurn } from './message-runtime-queue.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
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
    id: 'task-owner-retry',
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
    round_trip_count: 0,
    owner_failure_count: 1,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-03-30T00:00:00.000Z',
    updated_at: '2026-03-30T00:00:10.000Z',
    ...overrides,
  };
}

function makeChannel(): Channel {
  return {
    name: 'discord-owner',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

describe('message-runtime-queue owner retry turns', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
  });

  it('keeps stale human messages in failed owner retries as owner follow-up', async () => {
    const task = makeTask();
    createPairedTask(task);
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'error' as const,
      deliverySucceeded: false,
      visiblePhase: 'silent',
    }));

    const outcome = await runQueuedGroupTurn({
      chatJid: task.chat_jid,
      group: makeGroup(),
      runId: 'run-owner-retry-stale-human',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'human-owner-stale-1',
          chat_jid: task.chat_jid,
          sender: 'user@test',
          sender_name: 'User',
          content: '원 요청입니다',
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

    expect(outcome).toBe(false);
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        hasHumanMessage: false,
        deliveryRole: 'owner',
        forcedRole: 'owner',
        pairedTurnIdentity: {
          turnId: 'task-owner-retry:2026-03-30T00:00:10.000Z:owner-follow-up',
          taskId: 'task-owner-retry',
          taskUpdatedAt: '2026-03-30T00:00:10.000Z',
          intentKind: 'owner-follow-up',
          role: 'owner',
        },
      }),
    );
  });
});
