import { isArbiterEnabled } from './config.js';
import { logger } from './logger.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
import type { PairedTaskStatus } from './types.js';

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

export type RequestArbiterOrEscalateFn = typeof requestArbiterOrEscalate;
