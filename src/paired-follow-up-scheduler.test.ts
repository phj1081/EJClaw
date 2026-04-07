import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SCHEDULED_PAIRED_FOLLOW_UP_TTL_MS,
  buildPairedFollowUpKey,
  resetPairedFollowUpScheduleState,
  schedulePairedFollowUpOnce,
} from './paired-follow-up-scheduler.js';

describe('paired follow-up scheduler', () => {
  beforeEach(() => {
    resetPairedFollowUpScheduleState();
    vi.useRealTimers();
  });

  it('deduplicates the same follow-up intent while task state is unchanged', () => {
    const enqueue = vi.fn();
    const task = {
      id: 'task-1',
      status: 'review_ready',
      round_trip_count: 1,
    } as const;

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });
    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the same follow-up intent across different runs', () => {
    const enqueue = vi.fn();
    const task = {
      id: 'task-1',
      status: 'review_ready',
      round_trip_count: 1,
    } as const;

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });
    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-2',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('keeps different round trips schedulable', () => {
    const enqueue = vi.fn();

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task: {
        id: 'task-1',
        status: 'review_ready',
        round_trip_count: 1,
      } as const,
      intentKind: 'reviewer-turn',
      enqueue,
    });
    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task: {
        id: 'task-1',
        status: 'review_ready',
        round_trip_count: 2,
      } as const,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('builds a key that includes round trip count and intent', () => {
    expect(
      buildPairedFollowUpKey({
        taskId: 'task-1',
        taskStatus: 'review_ready',
        roundTripCount: 3,
        intentKind: 'reviewer-turn',
      }),
    ).toBe('task-1:review_ready:3:reviewer-turn');
  });

  it('allows the same follow-up again after the TTL expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'));

    const enqueue = vi.fn();
    const task = {
      id: 'task-1',
      status: 'review_ready',
      round_trip_count: 1,
    } as const;

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    vi.advanceTimersByTime(SCHEDULED_PAIRED_FOLLOW_UP_TTL_MS + 1);

    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
