import { updatePairedTaskIfUnchanged } from './db.js';
import { logger } from './logger.js';
import type { PairedTaskStatus } from './types.js';

export const ALLOWED_PAIRED_STATUS_TRANSITIONS: Record<
  PairedTaskStatus,
  ReadonlySet<PairedTaskStatus>
> = {
  active: new Set(['review_ready', 'arbiter_requested', 'completed']),
  review_ready: new Set([
    'active',
    'in_review',
    'arbiter_requested',
    'completed',
  ]),
  in_review: new Set([
    'active',
    'review_ready',
    'merge_ready',
    'arbiter_requested',
    'completed',
  ]),
  merge_ready: new Set(['active', 'arbiter_requested', 'completed']),
  completed: new Set(),
  arbiter_requested: new Set(['in_arbitration', 'completed']),
  in_arbitration: new Set(['active', 'arbiter_requested', 'completed']),
};

export function assertPairedTaskStatusTransition(args: {
  currentStatus: PairedTaskStatus;
  nextStatus: PairedTaskStatus;
}): void {
  const { currentStatus, nextStatus } = args;
  if (currentStatus === nextStatus) {
    return;
  }

  if (ALLOWED_PAIRED_STATUS_TRANSITIONS[currentStatus].has(nextStatus)) {
    return;
  }

  throw new Error(
    `Invalid paired task status transition: ${currentStatus} -> ${nextStatus}`,
  );
}

export function transitionPairedTaskStatus(args: {
  taskId: string;
  currentStatus: PairedTaskStatus;
  nextStatus: PairedTaskStatus;
  expectedUpdatedAt: string;
  updatedAt: string;
  patch?: {
    title?: string | null;
    source_ref?: string | null;
    plan_notes?: string | null;
    review_requested_at?: string | null;
    round_trip_count?: number;
    owner_failure_count?: number;
    owner_step_done_streak?: number;
    finalize_step_done_count?: number;
    task_done_then_user_reopen_count?: number;
    empty_step_done_streak?: number;
    arbiter_verdict?: string | null;
    arbiter_requested_at?: string | null;
    completion_reason?: string | null;
  };
}): boolean {
  assertPairedTaskStatusTransition({
    currentStatus: args.currentStatus,
    nextStatus: args.nextStatus,
  });

  const updated = updatePairedTaskIfUnchanged(
    args.taskId,
    args.expectedUpdatedAt,
    {
      ...args.patch,
      status: args.nextStatus,
      updated_at: args.updatedAt,
    },
  );
  if (!updated) {
    logger.warn(
      {
        taskId: args.taskId,
        currentStatus: args.currentStatus,
        nextStatus: args.nextStatus,
        expectedUpdatedAt: args.expectedUpdatedAt,
      },
      'Skipped stale paired task status transition because the task revision changed',
    );
  }
  return updated;
}

export function applyPairedTaskPatch(args: {
  taskId: string;
  expectedUpdatedAt: string;
  updatedAt: string;
  patch: {
    title?: string | null;
    source_ref?: string | null;
    plan_notes?: string | null;
    review_requested_at?: string | null;
    round_trip_count?: number;
    owner_failure_count?: number;
    owner_step_done_streak?: number;
    finalize_step_done_count?: number;
    task_done_then_user_reopen_count?: number;
    empty_step_done_streak?: number;
    status?: PairedTaskStatus;
    arbiter_verdict?: string | null;
    arbiter_requested_at?: string | null;
    completion_reason?: string | null;
  };
}): boolean {
  const updated = updatePairedTaskIfUnchanged(
    args.taskId,
    args.expectedUpdatedAt,
    {
      ...args.patch,
      updated_at: args.updatedAt,
    },
  );
  if (!updated) {
    logger.warn(
      {
        taskId: args.taskId,
        expectedUpdatedAt: args.expectedUpdatedAt,
      },
      'Skipped stale paired task patch because the task revision changed',
    );
  }
  return updated;
}

export type TransitionPairedTaskStatusFn = typeof transitionPairedTaskStatus;
export type ApplyPairedTaskPatchFn = typeof applyPairedTaskPatch;
