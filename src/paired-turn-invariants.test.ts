import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  SERVICE_SESSION_SCOPE: 'codex-main',
}));

vi.mock('./db.js', () => ({
  claimServiceHandoff: vi.fn(() => true),
  completeServiceHandoffAndAdvanceTargetCursor: vi.fn(
    () => '2026-04-15T00:00:09.000Z',
  ),
  failServiceHandoff: vi.fn(),
  getPendingServiceHandoffs: vi.fn(() => []),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as db from './db.js';
import { processClaimedHandoff } from './message-runtime-handoffs.js';
import {
  buildPairedTurnIdentity,
  resolveRuntimePairedTurnIdentity,
} from './paired-turn-identity.js';
import type { Channel, RegisteredGroup } from './types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: '2026-04-15T00:00:00.000Z',
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

describe('paired turn invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.completeServiceHandoffAndAdvanceTargetCursor).mockReturnValue(
      '2026-04-15T00:00:09.000Z',
    );
  });

  it('rejects a persisted turn identity when the explicit role conflicts with its intent kind', () => {
    expect(() =>
      buildPairedTurnIdentity({
        taskId: 'task-review',
        taskUpdatedAt: '2026-04-15T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'owner',
      }),
    ).toThrow('paired turn identity role mismatch');

    expect(() =>
      buildPairedTurnIdentity({
        taskId: 'task-arbiter',
        taskUpdatedAt: '2026-04-15T00:00:00.000Z',
        intentKind: 'arbiter-turn',
        role: 'reviewer',
      }),
    ).toThrow('paired turn identity role mismatch');
  });

  it('keeps reviewer and arbiter runtime identities fixed even when task status suggests owner work', () => {
    expect(
      resolveRuntimePairedTurnIdentity({
        taskId: 'task-review',
        taskUpdatedAt: '2026-04-15T00:00:00.000Z',
        role: 'reviewer',
        taskStatus: 'merge_ready',
        hasHumanMessage: true,
      }),
    ).toEqual({
      turnId: 'task-review:2026-04-15T00:00:00.000Z:reviewer-turn',
      taskId: 'task-review',
      taskUpdatedAt: '2026-04-15T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    expect(
      resolveRuntimePairedTurnIdentity({
        taskId: 'task-arbiter',
        taskUpdatedAt: '2026-04-15T00:00:00.000Z',
        role: 'arbiter',
        taskStatus: 'active',
        hasHumanMessage: true,
      }),
    ).toEqual({
      turnId: 'task-arbiter:2026-04-15T00:00:00.000Z:arbiter-turn',
      taskId: 'task-arbiter',
      taskUpdatedAt: '2026-04-15T00:00:00.000Z',
      intentKind: 'arbiter-turn',
      role: 'arbiter',
    });
  });

  it('fails closed when a claimed handoff resolves to a different logical role than the stored turn', async () => {
    const executeTurn = vi.fn();

    await processClaimedHandoff({
      handoff: {
        id: 13,
        chat_jid: 'group@test',
        group_folder: 'test-group',
        turn_id: 'task-review:2026-04-15T00:00:00.000Z:reviewer-turn',
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_service_id: 'claude',
        target_service_id: 'codex-main',
        source_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_role: 'owner',
        target_agent_type: 'codex',
        prompt: 'review retry',
        status: 'claimed',
        start_seq: 3,
        end_seq: 4,
        reason: 'reviewer-auth-failure',
        intended_role: 'owner',
        created_at: '2026-04-15T00:00:00.000Z',
        claimed_at: '2026-04-15T00:00:01.000Z',
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
      13,
      'Stored handoff turn_role reviewer conflicts with resolved role owner',
    );
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('advances reviewer handoff cursors in the reviewer-scoped namespace', async () => {
    const executeTurn = vi.fn(async () => ({
      outputStatus: 'success' as const,
      deliverySucceeded: true,
      visiblePhase: 'final',
    }));
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn();

    await processClaimedHandoff({
      handoff: {
        id: 17,
        chat_jid: 'group@test',
        group_folder: 'test-group',
        paired_task_id: 'task-reviewer-handoff',
        paired_task_updated_at: '2026-04-15T00:00:00.000Z',
        turn_id: 'task-reviewer-handoff:2026-04-15T00:00:00.000Z:reviewer-turn',
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
        created_at: '2026-04-15T00:00:00.000Z',
        claimed_at: '2026-04-15T00:00:01.000Z',
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
      lastAgentTimestamps,
      saveState,
    });

    expect(
      db.completeServiceHandoffAndAdvanceTargetCursor,
    ).toHaveBeenCalledWith({
      id: 17,
      chat_jid: 'group@test',
      cursor_key: 'group@test:reviewer',
      end_seq: 6,
    });
    expect(lastAgentTimestamps).toEqual({
      'group@test:reviewer': '2026-04-15T00:00:09.000Z',
    });
    expect(saveState).toHaveBeenCalledTimes(1);
  });
});
