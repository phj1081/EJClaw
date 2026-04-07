import {
  ARBITER_DEADLOCK_THRESHOLD,
  PAIRED_MAX_ROUND_TRIPS,
} from './config.js';
import { getPairedWorkspace, hasActiveCiWatcherForChat } from './db.js';
import { logger } from './logger.js';
import { markPairedTaskReviewReady } from './paired-workspace-manager.js';
import {
  applyPairedTaskPatch,
  hasCodeChangesSinceRef,
  parseVisibleVerdict,
  requestArbiterOrEscalate,
  resolveOwnerCompletionSignal,
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
  const ownerVerdict = parseVisibleVerdict(summary);
  const workspace = getPairedWorkspace(task.id, 'owner');
  const hasNewChanges = workspace?.workspace_dir
    ? hasCodeChangesSinceRef(workspace.workspace_dir, task.source_ref)
    : null;
  const signal = resolveOwnerCompletionSignal({
    phase: 'finalize',
    visibleVerdict: ownerVerdict,
    hasChangesSinceApproval: hasNewChanges,
    roundTripCount: task.round_trip_count,
    deadlockThreshold: ARBITER_DEADLOCK_THRESHOLD,
  });

  if (signal.kind === 'request_arbiter') {
    const arbiterLogMessage =
      ownerVerdict === 'blocked' || ownerVerdict === 'needs_context'
        ? 'Owner blocked during finalize — requesting arbiter'
        : ownerVerdict === 'done_with_concerns'
          ? 'Owner finalize loop detected — requesting arbiter'
          : 'Owner finalize DONE loop detected — requesting arbiter';
    const escalateLogMessage =
      ownerVerdict === 'blocked' || ownerVerdict === 'needs_context'
        ? 'Owner blocked during finalize — escalating to user'
        : ownerVerdict === 'done_with_concerns'
          ? 'Owner finalize loop detected — escalating to user'
          : 'Owner finalize DONE loop detected — escalating to user';
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      now,
      arbiterLogMessage,
      escalateLogMessage,
      logContext: {
        taskId,
        ownerVerdict,
        roundTrips: task.round_trip_count,
        hasNewChanges,
        summary: summary?.slice(0, 100),
      },
    });
    return 'stop';
  }

  if (signal.kind === 'request_reviewer') {
    if (signal.resetStatusToActive) {
      transitionPairedTaskStatus({
        taskId,
        currentStatus: task.status,
        nextStatus: 'active',
        updatedAt: now,
      });
    }
    logger.info(
      {
        taskId,
        ownerVerdict,
        hasNewChanges,
        summary: summary?.slice(0, 100),
      },
      ownerVerdict === 'done_with_concerns'
        ? 'Owner raised concerns during finalize — task set back to active'
        : 'Owner made changes after reviewer approval — task set back to active before re-review',
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

  const ownerVerdict = parseVisibleVerdict(summary);
  const signal = resolveOwnerCompletionSignal({
    phase: 'normal',
    visibleVerdict: ownerVerdict,
  });

  if (signal.kind === 'request_arbiter') {
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
