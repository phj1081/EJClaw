import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  updatePairedTaskIfUnchanged: vi.fn(() => true),
}));

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { updatePairedTaskIfUnchanged } from './db.js';
import { logger } from './logger.js';
import {
  applyPairedTaskPatch,
  assertPairedTaskStatusTransition,
  transitionPairedTaskStatus,
} from './paired-task-status.js';

describe('paired task status transitions', () => {
  beforeEach(() => {
    vi.mocked(updatePairedTaskIfUnchanged).mockReset();
    vi.mocked(updatePairedTaskIfUnchanged).mockReturnValue(true);
    vi.mocked(logger.warn).mockReset();
  });

  it('allows valid transitions and same-status no-ops', () => {
    expect(() =>
      assertPairedTaskStatusTransition({
        currentStatus: 'active',
        nextStatus: 'review_ready',
      }),
    ).not.toThrow();
    expect(() =>
      assertPairedTaskStatusTransition({
        currentStatus: 'review_ready',
        nextStatus: 'review_ready',
      }),
    ).not.toThrow();
  });

  it('rejects invalid transitions', () => {
    expect(() =>
      assertPairedTaskStatusTransition({
        currentStatus: 'completed',
        nextStatus: 'active',
      }),
    ).toThrow('Invalid paired task status transition: completed -> active');
  });

  it('writes status transitions with optimistic revision guard', () => {
    const updated = transitionPairedTaskStatus({
      taskId: 'task-1',
      currentStatus: 'active',
      nextStatus: 'review_ready',
      expectedUpdatedAt: '2026-04-29T01:00:00.000Z',
      updatedAt: '2026-04-29T01:01:00.000Z',
      patch: {
        review_requested_at: '2026-04-29T01:01:00.000Z',
      },
    });

    expect(updated).toBe(true);
    expect(updatePairedTaskIfUnchanged).toHaveBeenCalledWith(
      'task-1',
      '2026-04-29T01:00:00.000Z',
      {
        review_requested_at: '2026-04-29T01:01:00.000Z',
        status: 'review_ready',
        updated_at: '2026-04-29T01:01:00.000Z',
      },
    );
  });

  it('logs stale status transitions without writing success', () => {
    vi.mocked(updatePairedTaskIfUnchanged).mockReturnValue(false);

    const updated = transitionPairedTaskStatus({
      taskId: 'task-1',
      currentStatus: 'active',
      nextStatus: 'completed',
      expectedUpdatedAt: 'old',
      updatedAt: 'new',
      patch: {
        completion_reason: 'done',
      },
    });

    expect(updated).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        currentStatus: 'active',
        nextStatus: 'completed',
        expectedUpdatedAt: 'old',
      },
      'Skipped stale paired task status transition because the task revision changed',
    );
  });

  it('applies non-status patches with optimistic revision guard', () => {
    const updated = applyPairedTaskPatch({
      taskId: 'task-1',
      expectedUpdatedAt: 'old',
      updatedAt: 'new',
      patch: {
        owner_failure_count: 2,
      },
    });

    expect(updated).toBe(true);
    expect(updatePairedTaskIfUnchanged).toHaveBeenCalledWith('task-1', 'old', {
      owner_failure_count: 2,
      updated_at: 'new',
    });
  });
});
