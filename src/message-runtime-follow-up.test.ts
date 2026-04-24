import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getPairedTurnOutputs: vi.fn(() => []),
  reservePairedTurnReservation: vi.fn(() => true),
  claimPairedTurnReservation: vi.fn(() => true),
  _clearPairedTurnReservationsForTests: vi.fn(),
}));

import { getPairedTurnOutputs } from './db.js';
import {
  enqueuePairedFollowUpAfterEvent,
  dispatchPairedFollowUpForEvent,
  requeuePendingPairedTurn,
  schedulePairedFollowUpIntent,
  schedulePairedFollowUpWithMessageCheck,
} from './message-runtime-follow-up.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';

describe('message-runtime-follow-up', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    vi.mocked(getPairedTurnOutputs).mockReturnValue([]);
  });

  it('suppresses stale reviewer follow-ups when the latest persisted turn already belongs to the reviewer', () => {
    const enqueue = vi.fn();
    const task = {
      id: 'task-stale-reviewer',
      status: 'review_ready',
      round_trip_count: 1,
      updated_at: '2026-03-30T00:00:00.000Z',
    } as const;

    vi.mocked(getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: task.id,
        turn_number: 1,
        role: 'reviewer',
        output_text: 'reviewer 승인',
        created_at: '2026-03-30T00:00:01.000Z',
      },
    ] as any);

    const scheduled = schedulePairedFollowUpIntent({
      chatJid: 'group@test',
      runId: 'run-stale-reviewer',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(scheduled).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('uses the fallback delivery role to schedule owner follow-ups when no persisted turn output exists yet', () => {
    const enqueue = vi.fn();
    const result = dispatchPairedFollowUpForEvent({
      chatJid: 'group@test',
      runId: 'run-reviewer-delivery',
      task: {
        id: 'task-owner-follow-up',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      },
      source: 'delivery-success',
      completedRole: 'reviewer',
      fallbackLastTurnOutputRole: 'reviewer',
      enqueue,
    });

    expect(result).toMatchObject({
      kind: 'paired-follow-up',
      intentKind: 'owner-follow-up',
      scheduled: true,
      taskStatus: 'active',
      lastTurnOutputRole: 'reviewer',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not use fallback owner STEP_DONE verdict to schedule owner follow-ups while active', () => {
    const enqueue = vi.fn();
    const result = dispatchPairedFollowUpForEvent({
      chatJid: 'group@test',
      runId: 'run-owner-step-done',
      task: {
        id: 'task-owner-step-done',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      },
      source: 'owner-delivery-success',
      completedRole: 'owner',
      fallbackLastTurnOutputRole: 'owner',
      fallbackLastTurnOutputVerdict: 'step_done',
      enqueue,
    });

    expect(result).toMatchObject({
      kind: 'none',
      taskStatus: 'active',
      lastTurnOutputRole: 'owner',
      lastTurnOutputVerdict: 'step_done',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('prefers the latest persisted turn output over the fallback delivery role when both are present', () => {
    const enqueue = vi.fn();
    vi.mocked(getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-owner-follow-up-persisted',
        turn_number: 1,
        role: 'owner',
        output_text: 'owner 응답',
        created_at: '2026-03-30T00:00:01.000Z',
      },
    ] as any);

    const result = dispatchPairedFollowUpForEvent({
      chatJid: 'group@test',
      runId: 'run-reviewer-delivery-persisted',
      task: {
        id: 'task-owner-follow-up-persisted',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      },
      source: 'delivery-success',
      completedRole: 'reviewer',
      fallbackLastTurnOutputRole: 'reviewer',
      enqueue,
    });

    expect(result).toMatchObject({
      kind: 'none',
      taskStatus: 'active',
      lastTurnOutputRole: 'owner',
      nextTurnAction: { kind: 'none' },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('routes delivery retry with no remaining paired handoff to a message check', () => {
    const enqueue = vi.fn();
    const enqueueMessageCheck = vi.fn();

    const result = dispatchPairedFollowUpForEvent({
      chatJid: 'group@test',
      runId: 'run-delivery-retry',
      task: {
        id: 'task-retry-message-check',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      },
      source: 'delivery-retry',
      completedRole: 'owner',
      fallbackLastTurnOutputRole: 'owner',
      enqueue,
      enqueueMessageCheck,
    });

    expect(result).toMatchObject({
      kind: 'message-check',
      taskStatus: 'active',
      nextTurnAction: { kind: 'none' },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
  });

  it('uses the scoped message-check enqueuer when scheduling a paired follow-up intent', () => {
    const enqueueMessageCheck = vi.fn();
    const scheduled = schedulePairedFollowUpWithMessageCheck({
      chatJid: 'group@test',
      runId: 'run-scoped-enqueue',
      task: {
        id: 'task-scoped-enqueue',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      },
      intentKind: 'owner-follow-up',
      enqueueMessageCheck,
      fallbackLastTurnOutputRole: 'reviewer',
    });

    expect(scheduled).toBe(true);
    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
  });

  it('closes stdin only when a pending paired turn requeue was actually scheduled', () => {
    const schedulePairedFollowUp = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const closeStdin = vi.fn();
    const first = requeuePendingPairedTurn({
      schedulePairedFollowUp,
      closeStdin,
    });
    const second = requeuePendingPairedTurn({
      schedulePairedFollowUp,
      closeStdin,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(schedulePairedFollowUp).toHaveBeenCalledTimes(2);
    expect(closeStdin).toHaveBeenCalledTimes(1);
  });

  it('uses the same message-check side effect for delivery follow-up dispatch', () => {
    const enqueueMessageCheck = vi.fn();

    const result = enqueuePairedFollowUpAfterEvent({
      chatJid: 'group@test',
      runId: 'run-delivery-follow-up-helper',
      task: {
        id: 'task-delivery-follow-up-helper',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      },
      source: 'delivery-success',
      completedRole: 'reviewer',
      fallbackLastTurnOutputRole: 'reviewer',
      enqueueMessageCheck,
    });

    expect(result).toMatchObject({
      kind: 'paired-follow-up',
      intentKind: 'owner-follow-up',
      scheduled: true,
    });
    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
  });
});
