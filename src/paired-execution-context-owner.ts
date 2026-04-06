import {
  ARBITER_DEADLOCK_THRESHOLD,
  PAIRED_MAX_ROUND_TRIPS,
} from './config.js';
import {
  getPairedWorkspace,
  hasActiveCiWatcherForChat,
  updatePairedTask,
} from './db.js';
import { logger } from './logger.js';
import { markPairedTaskReviewReady } from './paired-workspace-manager.js';
import {
  classifyVerdict,
  hasCodeChangesSinceRef,
  requestArbiterOrEscalate,
  resolveCanonicalSourceRef,
} from './paired-execution-context-shared.js';
import type { PairedTask } from './types.js';

export function handleFailedOwnerExecution(args: {
  task: PairedTask;
  taskId: string;
}): void {
  const { task, taskId } = args;
  if (task.status !== 'active') {
    const now = new Date().toISOString();
    updatePairedTask(taskId, { status: 'active', updated_at: now });
    logger.info(
      { taskId, role: 'owner', previousStatus: task.status },
      'Reset task to active after failed execution',
    );
  }
}

function handleOwnerFinalizeCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
  now: string;
}): boolean {
  const { task, taskId, summary, now } = args;
  const ownerVerdict = classifyVerdict(summary);

  if (ownerVerdict === 'blocked' || ownerVerdict === 'needs_context') {
    requestArbiterOrEscalate({
      taskId,
      now,
      arbiterLogMessage: 'Owner blocked during finalize — requesting arbiter',
      escalateLogMessage: 'Owner blocked during finalize — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        summary: summary?.slice(0, 100),
      },
    });
    return true;
  }

  if (ownerVerdict === 'done_with_concerns') {
    if (task.round_trip_count >= ARBITER_DEADLOCK_THRESHOLD) {
      requestArbiterOrEscalate({
        taskId,
        now,
        arbiterLogMessage: 'Owner finalize loop detected — requesting arbiter',
        escalateLogMessage: 'Owner finalize loop detected — escalating to user',
        logContext: {
          taskId,
          ownerVerdict,
          roundTrips: task.round_trip_count,
        },
      });
      return true;
    }
    updatePairedTask(taskId, { status: 'active', updated_at: now });
    logger.info(
      {
        taskId,
        ownerVerdict,
        summary: summary?.slice(0, 100),
      },
      'Owner raised concerns during finalize — task set back to active',
    );
    return false;
  }

  const workspace = getPairedWorkspace(task.id, 'owner');
  const hasNewChanges = workspace?.workspace_dir
    ? hasCodeChangesSinceRef(workspace.workspace_dir, task.source_ref)
    : null;

  if (hasNewChanges === true) {
    if (task.round_trip_count >= ARBITER_DEADLOCK_THRESHOLD) {
      requestArbiterOrEscalate({
        taskId,
        now,
        arbiterLogMessage:
          'Owner finalize DONE loop detected — requesting arbiter',
        escalateLogMessage:
          'Owner finalize DONE loop detected — escalating to user',
        logContext: {
          taskId,
          roundTrips: task.round_trip_count,
          hasNewChanges,
        },
      });
      return true;
    }
    logger.info(
      {
        taskId,
        sourceRef: task.source_ref,
        hasNewChanges,
      },
      'Owner made changes after reviewer approval — re-triggering review',
    );
    return false;
  }

  updatePairedTask(taskId, {
    status: 'completed',
    completion_reason: 'done',
    updated_at: now,
  });
  logger.info(
    { taskId, hasNewChanges, summary: summary?.slice(0, 100) },
    'Owner finalized after reviewer approval — task completed',
  );
  return true;
}

export function handleOwnerCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();

  if (task.status === 'merge_ready') {
    const shouldStop = handleOwnerFinalizeCompletion({
      task,
      taskId,
      summary,
      now,
    });
    if (shouldStop) {
      return;
    }
  }

  if (hasActiveCiWatcherForChat(task.chat_jid)) {
    logger.info(
      { taskId, chatJid: task.chat_jid },
      'Active CI watcher found, deferring auto-review until watcher completes',
    );
    return;
  }

  if (task.status !== 'merge_ready') {
    const ownerVerdict = classifyVerdict(summary);
    if (ownerVerdict === 'blocked' || ownerVerdict === 'needs_context') {
      requestArbiterOrEscalate({
        taskId,
        now,
        arbiterLogMessage: 'Owner blocked/needs_context — requesting arbiter',
        escalateLogMessage: 'Owner blocked/needs_context — escalating to user',
        logContext: {
          taskId,
          ownerVerdict,
          summary: summary?.slice(0, 100),
        },
      });
      return;
    }
  }

  if (task.round_trip_count >= PAIRED_MAX_ROUND_TRIPS) {
    logger.info(
      {
        taskId,
        roundTrips: task.round_trip_count,
        max: PAIRED_MAX_ROUND_TRIPS,
      },
      'Round trip limit reached, skipping auto-review',
    );
    return;
  }

  const result = markPairedTaskReviewReady(taskId);
  if (result) {
    updatePairedTask(taskId, {
      round_trip_count: task.round_trip_count + 1,
      review_requested_at: now,
      updated_at: now,
    });
    logger.info(
      { taskId, roundTrip: task.round_trip_count + 1 },
      'Auto-triggered reviewer after owner completion',
    );
  }
}
