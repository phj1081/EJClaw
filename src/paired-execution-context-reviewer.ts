import { ARBITER_DEADLOCK_THRESHOLD } from './config.js';
import { getPairedWorkspace, updatePairedTask } from './db.js';
import { logger } from './logger.js';
import {
  classifyVerdict,
  requestArbiterOrEscalate,
  resolveCanonicalSourceRef,
} from './paired-execution-context-shared.js';
import type { PairedTask } from './types.js';

export function handleFailedReviewerExecution(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();

  if (summary) {
    const verdict = classifyVerdict(summary);
    if (
      verdict === 'done' ||
      verdict === 'blocked' ||
      verdict === 'needs_context'
    ) {
      const ownerWs =
        verdict === 'done' ? getPairedWorkspace(taskId, 'owner') : null;
      const approvedSourceRef =
        verdict === 'done' && ownerWs?.workspace_dir
          ? resolveCanonicalSourceRef(ownerWs.workspace_dir)
          : task.source_ref;
      updatePairedTask(taskId, {
        status: verdict === 'done' ? 'merge_ready' : 'completed',
        ...(verdict === 'done' ? { source_ref: approvedSourceRef } : {}),
        ...(verdict !== 'done' ? { completion_reason: 'escalated' } : {}),
        updated_at: now,
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
    updatePairedTask(taskId, { status: fallbackStatus, updated_at: now });
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
  const verdict = classifyVerdict(summary);

  switch (verdict) {
    case 'done': {
      const ownerWs = getPairedWorkspace(taskId, 'owner');
      const approvedSourceRef = ownerWs?.workspace_dir
        ? resolveCanonicalSourceRef(ownerWs.workspace_dir)
        : task.source_ref;
      updatePairedTask(taskId, {
        status: 'merge_ready',
        source_ref: approvedSourceRef,
        updated_at: now,
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

    case 'blocked':
    case 'needs_context':
      requestArbiterOrEscalate({
        taskId,
        now,
        arbiterLogMessage:
          'Reviewer blocked/needs_context — requesting arbiter before escalating',
        escalateLogMessage: 'Reviewer escalated to user — ping-pong stopped',
        logContext: { taskId, verdict, summary: summary?.slice(0, 100) },
      });
      return;

    case 'done_with_concerns':
    case 'continue':
    default:
      if (task.round_trip_count >= ARBITER_DEADLOCK_THRESHOLD) {
        requestArbiterOrEscalate({
          taskId,
          now,
          arbiterLogMessage:
            'Deadlock detected — requesting arbiter intervention',
          escalateLogMessage:
            'Stopped ping-pong — escalating to user (arbiter not configured)',
          logContext: {
            taskId,
            verdict,
            roundTrips: task.round_trip_count,
          },
        });
        return;
      }
      updatePairedTask(taskId, { status: 'active', updated_at: now });
      logger.info(
        { taskId, verdict },
        'Reviewer has feedback, task set back to active for owner',
      );
      return;
  }
}
