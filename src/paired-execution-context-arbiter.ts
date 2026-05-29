import { logger } from './logger.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
import { classifyArbiterVerdict } from './paired-verdict.js';
import type { PairedTask } from './types.js';

const ARBITER_RESOLUTION_ROUND_TRIP_COUNT = 0;

export function handleFailedArbiterExecution(args: {
  task: PairedTask;
  taskId: string;
}): void {
  const { task, taskId } = args;
  const now = new Date().toISOString();
  const fallbackStatus =
    task.status === 'in_arbitration' || task.status === 'arbiter_requested'
      ? 'arbiter_requested'
      : task.status;
  if (fallbackStatus !== task.status) {
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: fallbackStatus,
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
    });
    logger.warn(
      {
        taskId,
        role: 'arbiter',
        previousStatus: task.status,
        nextStatus: fallbackStatus,
      },
      'Preserved arbiter task in arbitration-requested state after failed execution',
    );
  }
}

export function handleArbiterCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();
  const arbiterVerdict = classifyArbiterVerdict(summary);

  logger.info(
    { taskId, arbiterVerdict, summary: summary?.slice(0, 200) },
    'Arbiter verdict rendered',
  );

  switch (arbiterVerdict) {
    case 'proceed':
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'review_ready',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          round_trip_count: ARBITER_RESOLUTION_ROUND_TRIP_COUNT,
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: 0,
          empty_step_done_streak: 0,
          arbiter_verdict: arbiterVerdict,
          arbiter_requested_at: null,
        },
      });
      logger.info(
        { taskId, arbiterVerdict },
        'Arbiter proceeded — returning task to reviewer for approval',
      );
      return;
    case 'revise':
    case 'reset':
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'active',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          round_trip_count: ARBITER_RESOLUTION_ROUND_TRIP_COUNT,
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: 0,
          empty_step_done_streak: 0,
          arbiter_verdict: arbiterVerdict,
          arbiter_requested_at: null,
        },
      });
      logger.info(
        { taskId, arbiterVerdict },
        'Arbiter requested owner changes — resuming owner flow',
      );
      return;
    case 'escalate':
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'completed',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          arbiter_verdict: 'escalate',
          completion_reason: 'arbiter_escalated',
        },
      });
      logger.info({ taskId }, 'Arbiter escalated to user — task completed');
      return;
    default:
      transitionPairedTaskStatus({
        taskId,
        currentStatus: 'in_arbitration',
        nextStatus: 'review_ready',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          round_trip_count: ARBITER_RESOLUTION_ROUND_TRIP_COUNT,
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: 0,
          empty_step_done_streak: 0,
          arbiter_verdict: 'unknown',
          arbiter_requested_at: null,
        },
      });
      logger.warn(
        { taskId, summary: summary?.slice(0, 200) },
        'Arbiter verdict unrecognized — returning task to reviewer as proceed fallback',
      );
      return;
  }
}
