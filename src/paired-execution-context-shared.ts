import { isArbiterEnabled } from './config.js';
import { updatePairedTaskIfUnchanged } from './db.js';
import { logger } from './logger.js';
import type { PairedTaskStatus } from './types.js';

export {
  resolveOwnerCompletionSignal,
  resolveReviewerCompletionSignal,
  resolveReviewerFailureSignal,
} from './paired-completion-signals.js';
export type { CompletionSignal } from './paired-completion-signals.js';
export {
  classifyArbiterVerdict,
  parseVisibleVerdict,
} from './paired-verdict.js';
export type { ArbiterVerdictResult, VisibleVerdict } from './paired-verdict.js';
export {
  hasCodeChangesSinceRef,
  resolveCanonicalSourceRef,
} from './paired-source-ref.js';

const ALLOWED_PAIRED_STATUS_TRANSITIONS: Record<
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

export function requestArbiterOrEscalate(args: {
  taskId: string;
  currentStatus: PairedTaskStatus;
  expectedUpdatedAt: string;
  now: string;
  arbiterLogMessage: string;
  escalateLogMessage: string;
  logContext?: Record<string, unknown>;
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
  const {
    taskId,
    currentStatus,
    expectedUpdatedAt,
    now,
    arbiterLogMessage,
    escalateLogMessage,
    logContext,
  } = args;
  if (isArbiterEnabled()) {
    const transitioned = transitionPairedTaskStatus({
      taskId,
      currentStatus,
      nextStatus: 'arbiter_requested',
      expectedUpdatedAt,
      updatedAt: now,
      patch: {
        ...args.patch,
        arbiter_requested_at: now,
      },
    });
    if (transitioned) {
      logger.info(logContext ?? { taskId }, arbiterLogMessage);
    }
    return transitioned;
  }

  const transitioned = transitionPairedTaskStatus({
    taskId,
    currentStatus,
    nextStatus: 'completed',
    expectedUpdatedAt,
    updatedAt: now,
    patch: {
      ...args.patch,
      completion_reason: 'escalated',
    },
  });
  if (transitioned) {
    logger.info(logContext ?? { taskId }, escalateLogMessage);
  }
  return transitioned;
}

export type TransitionPairedTaskStatusFn = typeof transitionPairedTaskStatus;
export type ApplyPairedTaskPatchFn = typeof applyPairedTaskPatch;
export type RequestArbiterOrEscalateFn = typeof requestArbiterOrEscalate;
