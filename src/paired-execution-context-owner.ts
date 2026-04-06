import {
  ARBITER_DEADLOCK_THRESHOLD,
  PAIRED_MAX_ROUND_TRIPS,
} from './config.js';
import { getPairedWorkspace, hasActiveCiWatcherForChat } from './db.js';
import { logger } from './logger.js';
import { markPairedTaskReviewReady } from './paired-workspace-manager.js';
import {
  applyPairedTaskPatch,
  classifyVerdict,
  hasCodeChangesSinceRef,
  requestArbiterOrEscalate,
  resolveCanonicalSourceRef,
  transitionPairedTaskStatus,
} from './paired-execution-context-shared.js';
import type { PairedTask } from './types.js';

type OwnerFinalizeOutcome = 'stop' | 're_review';

export function handleFailedOwnerExecution(args: {
  task: PairedTask;
  taskId: string;
}): void {
  const { task, taskId } = args;
  if (task.status !== 'active') {
    const now = new Date().toISOString();
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: 'active',
      updatedAt: now,
    });
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
}): OwnerFinalizeOutcome {
  const { task, taskId, summary, now } = args;
  const ownerVerdict = classifyVerdict(summary);

  if (ownerVerdict === 'blocked' || ownerVerdict === 'needs_context') {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      now,
      arbiterLogMessage: 'Owner blocked during finalize — requesting arbiter',
      escalateLogMessage: 'Owner blocked during finalize — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        summary: summary?.slice(0, 100),
      },
    });
    return 'stop';
  }

  if (ownerVerdict === 'done_with_concerns') {
    if (task.round_trip_count >= ARBITER_DEADLOCK_THRESHOLD) {
      requestArbiterOrEscalate({
        taskId,
        currentStatus: task.status,
        now,
        arbiterLogMessage: 'Owner finalize loop detected — requesting arbiter',
        escalateLogMessage: 'Owner finalize loop detected — escalating to user',
        logContext: {
          taskId,
          ownerVerdict,
          roundTrips: task.round_trip_count,
        },
      });
      return 'stop';
    }
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: 'active',
      updatedAt: now,
    });
    logger.info(
      {
        taskId,
        ownerVerdict,
        summary: summary?.slice(0, 100),
      },
      'Owner raised concerns during finalize — task set back to active',
    );
    return 're_review';
  }

  const workspace = getPairedWorkspace(task.id, 'owner');
  const hasNewChanges = workspace?.workspace_dir
    ? hasCodeChangesSinceRef(workspace.workspace_dir, task.source_ref)
    : null;

  if (hasNewChanges === true) {
    if (task.round_trip_count >= ARBITER_DEADLOCK_THRESHOLD) {
      requestArbiterOrEscalate({
        taskId,
        currentStatus: task.status,
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
      return 'stop';
    }
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: 'active',
      updatedAt: now,
    });
    logger.info(
      {
        taskId,
        sourceRef: task.source_ref,
        hasNewChanges,
      },
      'Owner made changes after reviewer approval — task set back to active before re-review',
    );
    return 're_review';
  }

  transitionPairedTaskStatus({
    taskId,
    currentStatus: task.status,
    nextStatus: 'completed',
    updatedAt: now,
    patch: {
      completion_reason: 'done',
    },
  });
  logger.info(
    { taskId, hasNewChanges, summary: summary?.slice(0, 100) },
    'Owner finalized after reviewer approval — task completed',
  );
  return 'stop';
}

function maybeAutoTriggerReviewerAfterOwnerCompletion(args: {
  task: PairedTask;
  taskId: string;
  now: string;
  logMessage: string;
}): void {
  const { task, taskId, now, logMessage } = args;

  if (hasActiveCiWatcherForChat(task.chat_jid)) {
    logger.info(
      { taskId, chatJid: task.chat_jid },
      'Active CI watcher found, deferring auto-review until watcher completes',
    );
    return;
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
    applyPairedTaskPatch({
      taskId,
      updatedAt: now,
      patch: {
        round_trip_count: task.round_trip_count + 1,
      },
    });
    logger.info({ taskId, roundTrip: task.round_trip_count + 1 }, logMessage);
  }
}

export function handleOwnerCompletion(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();

  if (task.status === 'merge_ready') {
    const finalizeOutcome = handleOwnerFinalizeCompletion({
      task,
      taskId,
      summary,
      now,
    });
    if (finalizeOutcome === 're_review') {
      maybeAutoTriggerReviewerAfterOwnerCompletion({
        task,
        taskId,
        now,
        logMessage:
          'Auto-triggered reviewer after owner finalize required re-review',
      });
    }
    return;
  }

  const ownerVerdict = classifyVerdict(summary);
  if (ownerVerdict === 'blocked' || ownerVerdict === 'needs_context') {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
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

  maybeAutoTriggerReviewerAfterOwnerCompletion({
    task,
    taskId,
    now,
    logMessage: 'Auto-triggered reviewer after owner completion',
  });
}
