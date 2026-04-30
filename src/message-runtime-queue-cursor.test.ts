import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createPairedTask } from './db.js';
import { runQueuedGroupTurn } from './message-runtime-queue.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import type {
  Channel,
  NewMessage,
  PairedTask,
  RegisteredGroup,
} from './types.js';

type RunQueuedGroupTurnArgs = Parameters<typeof runQueuedGroupTurn>[0];

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
    id: 'task-queued-cursor',
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
    review_requested_at: null,
    round_trip_count: 1,
    status: 'active',
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
    name: 'discord-owner',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

function makeQueuedTurnArgs(overrides: {
  task: PairedTask;
  executeTurn: RunQueuedGroupTurnArgs['executeTurn'];
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  log?: RunQueuedGroupTurnArgs['log'];
}): RunQueuedGroupTurnArgs {
  return {
    chatJid: overrides.task.chat_jid,
    group: makeGroup(),
    runId: 'run-owner-queued-cursor',
    log:
      overrides.log ??
      ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any),
    timezone: 'UTC',
    missedMessages: [
      {
        id: 'human-owner-cursor',
        chat_jid: overrides.task.chat_jid,
        sender: 'user@test',
        sender_name: 'User',
        content: '중간에 이 내용도 봐줘',
        timestamp: '2026-03-30T00:00:04.000Z',
        seq: 48,
        is_bot_message: false,
      },
    ],
    task: overrides.task,
    roleToChannel: {
      owner: null,
      reviewer: makeChannel(),
      arbiter: null,
    },
    ownerChannel: makeChannel(),
    lastAgentTimestamps: overrides.lastAgentTimestamps,
    saveState: overrides.saveState,
    executeTurn: overrides.executeTurn,
    getFixedRoleChannelName: () => 'discord-review',
    labelPairedSenders: (_chatJid: string, messages: NewMessage[]) => messages,
    formatMessages: () => 'formatted prompt',
  };
}

describe('message-runtime queued cursor handling', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
  });

  it('keeps the queued human cursor when the owner turn fails silently', async () => {
    const task = makeTask({
      owner_service_id: 'codex',
      owner_agent_type: 'codex',
    });
    createPairedTask(task);
    const executeTurn: RunQueuedGroupTurnArgs['executeTurn'] = vi.fn(
      async () => ({
        outputStatus: 'error' as const,
        deliverySucceeded: true,
        visiblePhase: 'silent',
      }),
    );
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn(() => undefined);
    const logMocks = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = logMocks as unknown as RunQueuedGroupTurnArgs['log'];

    const outcome = await runQueuedGroupTurn(
      makeQueuedTurnArgs({
        task,
        executeTurn,
        lastAgentTimestamps,
        saveState,
        log,
      }),
    );

    expect(outcome).toBe(false);
    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(lastAgentTimestamps).toEqual({});
    expect(saveState).toHaveBeenCalledTimes(2);
    expect(logMocks.warn).toHaveBeenCalledWith(
      {
        messageSeqStart: 48,
        messageSeqEnd: 48,
      },
      'Queued run failed before producing visible output; keeping cursor for retry',
    );
  });

  it('advances the queued human cursor when a silent owner turn succeeds', async () => {
    const task = makeTask({
      owner_service_id: 'codex',
      owner_agent_type: 'codex',
    });
    createPairedTask(task);
    const executeTurn: RunQueuedGroupTurnArgs['executeTurn'] = vi.fn(
      async () => ({
        outputStatus: 'success' as const,
        deliverySucceeded: true,
        visiblePhase: 'silent',
      }),
    );
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn(() => undefined);

    const outcome = await runQueuedGroupTurn(
      makeQueuedTurnArgs({
        task,
        executeTurn,
        lastAgentTimestamps,
        saveState,
      }),
    );

    expect(outcome).toBe(true);
    expect(lastAgentTimestamps).toEqual({ 'group@test': '48' });
    expect(saveState).toHaveBeenCalledTimes(1);
  });
});
