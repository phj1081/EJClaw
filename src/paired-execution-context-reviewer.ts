import { ARBITER_DEADLOCK_THRESHOLD } from './config.js';
import { getPairedWorkspace } from './db.js';
import { logger } from './logger.js';
import { requestArbiterOrEscalate } from './paired-arbiter-request.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
import {
  resolveReviewerCompletionSignal,
  resolveReviewerFailureSignal,
} from './paired-completion-signals.js';
import { resolveCanonicalSourceRef } from './paired-source-ref.js';
import { parseVisibleVerdict } from './paired-verdict.js';
import type { PairedTask } from './types.js';

export function handleFailedReviewerExecution(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();

  if (summary) {
    const verdict = parseVisibleVerdict(summary);
    const signal = resolveReviewerFailureSignal({
      visibleVerdict: verdict,
    });
    if (
      signal.kind === 'request_owner_finalize' ||
      signal.kind === 'complete'
    ) {
      const ownerWs =
        signal.kind === 'request_owner_finalize'
          ? getPairedWorkspace(taskId, 'owner')
          : null;
      const approvedSourceRef =
        signal.kind === 'request_owner_finalize' && ownerWs?.workspace_dir
          ? resolveCanonicalSourceRef(ownerWs.workspace_dir)
          : task.source_ref;
      transitionPairedTaskStatus({
        taskId,
        currentStatus: task.status,
        nextStatus:
          signal.kind === 'request_owner_finalize'
            ? 'merge_ready'
            : 'completed',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          ...(signal.kind === 'request_owner_finalize'
            ? { source_ref: approvedSourceRef }
            : {}),
          ...(signal.kind === 'complete'
            ? { completion_reason: signal.completionReason }
            : {}),
        },
      });
      logger.info(
        {
          taskId,
          verdict,
          approvedSourceRef,
          summary: summary.slice(0, 100),
        },
        'Reviewer verdict detected from failed execution — stopping ping-pong',
      );
      return;
    }
  }

  const fallbackStatus =
    task.status === 'in_review' || task.status === 'review_ready'
      ? 'review_ready'
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
        role: 'reviewer',
        previousStatus: task.status,
        nextStatus: fallbackStatus,
      },
      'Preserved reviewer task in review-ready state after failed execution',
    );
  }
}

export function handleReviewerCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();
  const verdict = parseVisibleVerdict(summary);
  const signal = resolveReviewerCompletionSignal({
    visibleVerdict: verdict,
    roundTripCount: task.round_trip_count,
    deadlockThreshold: ARBITER_DEADLOCK_THRESHOLD,
  });

  switch (signal.kind) {
    case 'request_owner_finalize': {
      const ownerWs = getPairedWorkspace(taskId, 'owner');
      const approvedSourceRef = ownerWs?.workspace_dir
        ? resolveCanonicalSourceRef(ownerWs.workspace_dir)
        : task.source_ref;
      transitionPairedTaskStatus({
        taskId,
        currentStatus: task.status,
        nextStatus: 'merge_ready',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          source_ref: approvedSourceRef,
        },
      });
      logger.info(
        {
          taskId,
          verdict,
          approvedSourceRef,
          summary: summary?.slice(0, 100),
        },
        'Reviewer approved — owner gets final turn to finalize',
      );
      return;
    }

    case 'request_arbiter': {
      const arbiterLogMessage =
        verdict === 'blocked' || verdict === 'needs_context'
          ? 'Reviewer blocked/needs_context — requesting arbiter before escalating'
          : 'Deadlock detected — requesting arbiter intervention';
      const escalateLogMessage =
        verdict === 'blocked' || verdict === 'needs_context'
          ? 'Reviewer escalated to user — ping-pong stopped'
          : 'Stopped ping-pong — escalating to user (arbiter not configured)';
      requestArbiterOrEscalate({
        taskId,
        currentStatus: task.status,
        expectedUpdatedAt: task.updated_at,
        now,
        arbiterLogMessage,
        escalateLogMessage,
        logContext: { taskId, verdict, summary: summary?.slice(0, 100) },
      });
      return;
    }

    case 'request_owner_changes':
      transitionPairedTaskStatus({
        taskId,
        currentStatus: task.status,
        nextStatus: 'active',
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
      });
      logger.info(
        { taskId, verdict },
        'Reviewer has feedback, task set back to active for owner',
      );
      return;
    default:
      return;
  }
}
