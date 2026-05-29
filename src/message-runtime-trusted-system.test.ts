import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createPairedTask } from './db.js';
import { runQueuedGroupTurn } from './message-runtime-queue.js';
import {
  isBotOrTrustedSystemMessage,
  isExternalHumanMessage,
} from './message-runtime-rules.js';
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

function makeTask(): PairedTask {
  return {
    id: 'task-trusted-system',
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

describe('trusted system message routing', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
  });

  it('does not classify trusted external bot events as human interruptions', () => {
    const trustedEvent = {
      is_from_me: false,
      is_bot_message: false,
      message_source_kind: 'trusted_external_bot' as const,
    };

    expect(isExternalHumanMessage(trustedEvent)).toBe(false);
    expect(isBotOrTrustedSystemMessage(trustedEvent)).toBe(true);
    expect(
      isExternalHumanMessage({
        is_from_me: false,
        is_bot_message: false,
        message_source_kind: 'human',
      }),
    ).toBe(true);
  });

  it('keeps trusted CI completions on the pending reviewer path', async () => {
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
      runId: 'run-ci-completion-reviewer',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      timezone: 'UTC',
      missedMessages: [
        {
          id: 'watch-ci-completed:task-1',
          chat_jid: task.chat_jid,
          sender: 'ci-watcher',
          sender_name: 'CI watcher',
          content: '[CI watcher completed]\nCI succeeded',
          timestamp: '2026-03-30T00:00:02.000Z',
          seq: 46,
          is_from_me: false,
          is_bot_message: false,
          message_source_kind: 'trusted_external_bot',
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
          turnId: 'task-trusted-system:2026-03-30T00:00:00.000Z:reviewer-turn',
          taskId: 'task-trusted-system',
          taskUpdatedAt: '2026-03-30T00:00:00.000Z',
          intentKind: 'reviewer-turn',
          role: 'reviewer',
        },
      }),
    );
  });
});
