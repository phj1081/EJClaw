import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getLatestOpenPairedTaskForChat } from './db.js';
import { runQueuedGroupTurn } from './message-runtime-queue.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import type { Channel, RegisteredGroup } from './types.js';

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

describe('message-runtime queue progress persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
  });

  it('creates a paired owner task before the first queued turn so progress has a turn identity', async () => {
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'progress',
    }));
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn();

    const outcome = await runQueuedGroupTurn({
      chatJid: 'group@test',
      group: makeGroup(),
      runId: 'run-new-paired-owner',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'human-new-task-1',
          chat_jid: 'group@test',
          sender: 'user@test',
          sender_name: 'User',
          content: '새 작업입니다',
          timestamp: '2026-03-30T00:00:03.000Z',
          seq: 48,
          is_bot_message: false,
        },
      ],
      task: null,
      roleToChannel: {
        owner: null,
        reviewer: makeChannel(),
        arbiter: null,
      },
      ownerChannel: makeChannel(),
      lastAgentTimestamps,
      saveState,
      executeTurn,
      getFixedRoleChannelName: () => 'discord-review',
      labelPairedSenders: (_chatJid, messages) => messages,
      formatMessages: () => 'formatted prompt',
    });

    const freshTask = getLatestOpenPairedTaskForChat('group@test');
    expect(outcome).toBe(true);
    expect(freshTask).toBeDefined();
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryRole: 'owner',
        forcedRole: 'owner',
        pairedTurnIdentity: {
          turnId: `${freshTask!.id}:${freshTask!.updated_at}:owner-turn`,
          taskId: freshTask!.id,
          taskUpdatedAt: freshTask!.updated_at,
          intentKind: 'owner-turn',
          role: 'owner',
        },
      }),
    );
    expect(lastAgentTimestamps).toEqual({ 'group@test': '48' });
    expect(saveState).toHaveBeenCalled();
  });
});
