import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getPairedTurnOutputs: vi.fn(() => []),
  reservePairedTurnReservation: vi.fn(() => true),
}));

import { getPairedTurnOutputs } from './db.js';
import { dispatchPairedFollowUpForEvent } from './message-runtime-follow-up.js';
import {
  matchesExpectedPairedFollowUpIntent,
  resolveNextTurnAction,
} from './message-runtime-rules.js';

describe('arbiter Codex failure owner wake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPairedTurnOutputs).mockReturnValue([]);
  });

  it('keeps owner follow-ups schedulable when active task has owner failure count', () => {
    const followUpContext = {
      taskStatus: 'active' as const,
      lastTurnOutputRole: 'owner' as const,
      lastTurnOutputVerdict: 'step_done' as const,
      ownerFailureCount: 1,
    };

    expect(resolveNextTurnAction(followUpContext)).toEqual({
      kind: 'owner-follow-up',
    });
    expect(
      matchesExpectedPairedFollowUpIntent({
        ...followUpContext,
        intentKind: 'owner-follow-up',
      }),
    ).toBe(true);
  });

  it('requeues owner follow-up when arbiter Codex failure returns the task active', () => {
    const enqueue = vi.fn();
    vi.mocked(getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-arbiter-codex-unavailable',
        turn_number: 1,
        role: 'owner',
        output_text: 'STEP_DONE\nwaiting for CI',
        verdict: 'step_done',
        created_at: '2026-03-30T00:00:01.000Z',
      },
    ] as any);

    const result = dispatchPairedFollowUpForEvent({
      chatJid: 'group@test',
      runId: 'run-arbiter-codex-unavailable',
      task: {
        id: 'task-arbiter-codex-unavailable',
        status: 'active',
        round_trip_count: 1,
        owner_failure_count: 1,
        updated_at: '2026-03-30T00:00:02.000Z',
      },
      source: 'executor-recovery',
      completedRole: 'arbiter',
      executionStatus: 'failed',
      sawOutput: false,
      enqueue,
    });

    expect(result).toMatchObject({
      kind: 'paired-follow-up',
      intentKind: 'owner-follow-up',
      scheduled: true,
      taskStatus: 'active',
      lastTurnOutputRole: 'owner',
      nextTurnAction: { kind: 'owner-follow-up' },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
