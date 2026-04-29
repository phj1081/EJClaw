import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  SERVICE_SESSION_SCOPE: 'codex-main',
}));

vi.mock('./db.js', () => ({
  claimServiceHandoff: vi.fn(() => true),
  claimPairedTurnReservation: vi.fn(() => true),
  completeServiceHandoffAndAdvanceTargetCursor: vi.fn(() => null),
  failServiceHandoff: vi.fn(),
  getPairedTaskById: vi.fn(),
  getPairedTurnOutputs: vi.fn(() => []),
  getPendingServiceHandoffs: vi.fn(() => []),
  reservePairedTurnReservation: vi.fn(() => true),
  _clearPairedTurnReservationsForTests: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as db from './db.js';
import {
  enqueueMessageRuntimePendingHandoffs,
  enqueuePendingHandoffs,
  processClaimedHandoff,
} from './message-runtime-handoffs.js';
import type { Channel, RegisteredGroup } from './types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: '2026-04-10T00:00:00.000Z',
    requiresTrigger: false,
    agentType: 'codex',
  };
}

function makeChannel(name: string, ownsChatJid = false): Channel {
  return {
    name,
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => ownsChatJid && jid === 'group@test'),
    sendMessage: vi.fn(),
  } as unknown as Channel;
}

function makeClaimedHandoff(overrides: Record<string, unknown> = {}) {
  return {
    id: 13,
    chat_jid: 'group@test',
    group_folder: 'test-group',
    source_service_id: 'claude',
    target_service_id: 'codex-main',
    source_role: 'reviewer',
    source_agent_type: 'claude-code',
    target_role: 'owner',
    target_agent_type: 'codex',
    prompt: 'owner handoff',
    status: 'claimed',
    start_seq: 13,
    end_seq: 14,
    reason: 'owner-follow-up',
    intended_role: 'owner',
    created_at: '2026-04-10T00:00:00.000Z',
    claimed_at: '2026-04-10T00:00:01.000Z',
    completed_at: null,
    last_error: null,
    ...overrides,
  } as any;
}

describe('enqueueMessageRuntimePendingHandoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues pending handoffs with runtime-bound processing dependencies', async () => {
    const handoff = makeClaimedHandoff();
    vi.mocked(db.getPendingServiceHandoffs).mockReturnValue([handoff]);
    vi.mocked(db.claimServiceHandoff).mockReturnValue(true);
    vi.mocked(db.completeServiceHandoffAndAdvanceTargetCursor).mockReturnValue(
      '14',
    );
    const enqueueTask = vi.fn();
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));
    const lastAgentTimestamps: Record<string, string> = {};
    const getLastAgentTimestamps = vi.fn(() => lastAgentTimestamps);
    const saveState = vi.fn();
    const enqueueMessageCheck = vi.fn();

    enqueueMessageRuntimePendingHandoffs({
      enqueueTask,
      getRoomBindings: () => ({
        'group@test': makeGroup(),
      }),
      channels: [makeChannel('discord-main', true)],
      executeTurn,
      getLastAgentTimestamps,
      saveState,
      enqueueMessageCheck,
    });

    expect(db.getPendingServiceHandoffs).toHaveBeenCalledWith('codex-main');
    expect(db.claimServiceHandoff).toHaveBeenCalledWith(13);
    expect(getLastAgentTimestamps).not.toHaveBeenCalled();
    expect(enqueueTask).toHaveBeenCalledWith(
      'group@test',
      'handoff:13',
      expect.any(Function),
    );

    const queuedTask = vi.mocked(enqueueTask).mock.calls[0]?.[2];
    await queuedTask?.();

    expect(getLastAgentTimestamps).toHaveBeenCalledTimes(1);
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'group@test',
        runId: 'handoff-13',
        forcedRole: 'owner',
        forcedAgentType: 'codex',
      }),
    );
    expect(lastAgentTimestamps['group@test']).toBe('14');
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });
});

describe('message-runtime-handoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not expose reviewer-targeted handoffs to the codex-main poller', () => {
    vi.mocked(db.getPendingServiceHandoffs).mockImplementation(
      (targetServiceId?: string) =>
        targetServiceId === 'codex-main'
          ? []
          : ([
              {
                id: 1,
                chat_jid: 'group@test',
                group_folder: 'test-group',
                source_service_id: 'claude',
                target_service_id: 'codex-review',
                source_role: 'reviewer',
                source_agent_type: 'claude-code',
                target_role: 'reviewer',
                target_agent_type: 'codex',
                prompt: 'review retry',
                status: 'pending',
                start_seq: 1,
                end_seq: 2,
                reason: 'reviewer-auth-failure',
                intended_role: 'reviewer',
                created_at: '2026-04-10T00:00:00.000Z',
                claimed_at: null,
                completed_at: null,
                last_error: null,
              },
            ] as any),
    );

    const enqueueTask = vi.fn();

    enqueuePendingHandoffs({
      enqueueTask,
      processClaimedHandoff: vi.fn(),
    });

    expect(db.getPendingServiceHandoffs).toHaveBeenCalledWith('codex-main');
    expect(db.claimServiceHandoff).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('fails a claimed handoff closed when its intended role cannot be resolved', async () => {
    const executeTurn = vi.fn();

    await processClaimedHandoff({
      handoff: {
        id: 7,
        chat_jid: 'group@test',
        group_folder: 'test-group',
        source_service_id: 'claude',
        target_service_id: 'codex-main',
        source_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_role: null,
        target_agent_type: 'codex',
        prompt: 'review retry',
        status: 'claimed',
        start_seq: 3,
        end_seq: 4,
        reason: 'unknown-failure',
        intended_role: null,
        created_at: '2026-04-10T00:00:00.000Z',
        claimed_at: '2026-04-10T00:00:01.000Z',
        completed_at: null,
        last_error: null,
      },
      getRoomBindings: () => ({
        'group@test': makeGroup(),
      }),
      channels: [makeChannel('discord-main', true)],
      executeTurn,
      lastAgentTimestamps: {},
      saveState: vi.fn(),
    });

    expect(db.failServiceHandoff).toHaveBeenCalledWith(
      7,
      'Cannot resolve intended handoff role',
    );
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('executes a reviewer handoff with a fixed reviewer role and channel', async () => {
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));

    await processClaimedHandoff({
      handoff: {
        id: 9,
        chat_jid: 'group@test',
        group_folder: 'test-group',
        paired_task_id: 'task-reviewer-handoff',
        paired_task_updated_at: '2026-04-10T00:00:00.000Z',
        turn_id: 'task-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_service_id: 'claude',
        target_service_id: 'codex-review',
        source_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_role: 'reviewer',
        target_agent_type: 'codex',
        prompt: 'review retry',
        status: 'claimed',
        start_seq: 5,
        end_seq: 6,
        reason: 'reviewer-auth-failure',
        intended_role: 'reviewer',
        created_at: '2026-04-10T00:00:00.000Z',
        claimed_at: '2026-04-10T00:00:01.000Z',
        completed_at: null,
        last_error: null,
      },
      getRoomBindings: () => ({
        'group@test': makeGroup(),
      }),
      channels: [
        makeChannel('discord-main', true),
        makeChannel('discord-review'),
      ],
      executeTurn,
      lastAgentTimestamps: {},
      saveState: vi.fn(),
    });

    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'group@test',
        forcedRole: 'reviewer',
        forcedAgentType: 'codex',
        pairedTurnIdentity: {
          turnId:
            'task-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
          taskId: 'task-reviewer-handoff',
          taskUpdatedAt: '2026-04-10T00:00:00.000Z',
          intentKind: 'reviewer-turn',
          role: 'reviewer',
        },
        channel: expect.objectContaining({
          name: 'discord-review',
        }),
      }),
    );
    expect(db.failServiceHandoff).not.toHaveBeenCalled();
  });

  it('recreates a pending reviewer retry after a claimed handoff delivery failure', async () => {
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'error' as const,
      deliverySucceeded: false,
      visiblePhase: 'final',
    }));
    const enqueueMessageCheck = vi.fn();
    const getPairedTaskById = vi.fn(() => ({
      id: 'task-reviewer-handoff-retry',
      status: 'review_ready' as const,
      round_trip_count: 1,
      updated_at: '2026-04-10T00:00:00.000Z',
    }));

    await processClaimedHandoff({
      handoff: {
        id: 11,
        chat_jid: 'group@test',
        group_folder: 'test-group',
        paired_task_id: 'task-reviewer-handoff-retry',
        paired_task_updated_at: '2026-04-10T00:00:00.000Z',
        turn_id:
          'task-reviewer-handoff-retry:2026-04-10T00:00:00.000Z:reviewer-turn',
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_service_id: 'claude',
        target_service_id: 'codex-review',
        source_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_role: 'reviewer',
        target_agent_type: 'codex',
        prompt: 'review retry after claimed handoff failure',
        status: 'claimed',
        start_seq: 7,
        end_seq: 8,
        reason: 'reviewer-auth-failure',
        intended_role: 'reviewer',
        created_at: '2026-04-10T00:00:00.000Z',
        claimed_at: '2026-04-10T00:00:01.000Z',
        completed_at: null,
        last_error: null,
      },
      getRoomBindings: () => ({
        'group@test': makeGroup(),
      }),
      channels: [
        makeChannel('discord-main', true),
        makeChannel('discord-review'),
      ],
      executeTurn,
      lastAgentTimestamps: {},
      saveState: vi.fn(),
      getPairedTaskById,
      enqueueMessageCheck,
    });

    expect(db.failServiceHandoff).toHaveBeenCalledWith(
      11,
      'Handoff delivery failed',
    );
    expect(getPairedTaskById).toHaveBeenCalledWith(
      'task-reviewer-handoff-retry',
    );
    expect(db.reservePairedTurnReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'group@test',
        taskId: 'task-reviewer-handoff-retry',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'reviewer-turn',
      }),
    );
    expect(enqueueMessageCheck).toHaveBeenCalledWith('group@test');
  });
});
