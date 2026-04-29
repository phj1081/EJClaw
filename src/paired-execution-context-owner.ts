import {
  ARBITER_DEADLOCK_THRESHOLD,
  PAIRED_MAX_ROUND_TRIPS,
} from './config.js';
import {
  getPairedTaskById,
  getPairedWorkspace,
  hasActiveCiWatcherForChat,
} from './db.js';
import { logger } from './logger.js';
import { markPairedTaskReviewReady } from './paired-workspace-manager.js';
import { requestArbiterOrEscalate } from './paired-arbiter-request.js';
import {
  applyPairedTaskPatch,
  transitionPairedTaskStatus,
} from './paired-task-status.js';
import { resolveOwnerCompletionSignal } from './paired-completion-signals.js';
import { hasCodeChangesSinceRef } from './paired-source-ref.js';
import { parseVisibleVerdict } from './paired-verdict.js';
import type { PairedTask } from './types.js';

type OwnerFinalizeOutcome = 'stop' | 're_review';
const OWNER_FAILURE_ESCALATION_THRESHOLD = 2;
const EMPTY_STEP_DONE_THRESHOLD = 2;

export function handleFailedOwnerExecution(args: {
  task: PairedTask;
  taskId: string;
  summary?: string | null;
}): void {
  const { task, taskId, summary } = args;
  const now = new Date().toISOString();
  const nextFailureCount = (task.owner_failure_count ?? 0) + 1;

  if (nextFailureCount >= OWNER_FAILURE_ESCALATION_THRESHOLD) {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage:
        'Owner failed repeatedly without a visible verdict — requesting arbiter',
      escalateLogMessage:
        'Owner failed repeatedly without a visible verdict — escalating to user',
      logContext: {
        taskId,
        role: 'owner',
        previousStatus: task.status,
        ownerFailureCount: nextFailureCount,
        summary: summary?.slice(0, 160),
      },
      patch: {
        owner_failure_count: nextFailureCount,
      },
    });
    return;
  }

  if (task.status !== 'active') {
    transitionPairedTaskStatus({
      taskId,
      currentStatus: task.status,
      nextStatus: 'active',
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch: {
        owner_failure_count: nextFailureCount,
      },
    });
  } else {
    applyPairedTaskPatch({
      taskId,
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch: {
        owner_failure_count: nextFailureCount,
      },
    });
  }
  logger.info(
    {
      taskId,
      role: 'owner',
      previousStatus: task.status,
      ownerFailureCount: nextFailureCount,
      summary: summary?.slice(0, 160),
    },
    'Reset task to active after failed owner execution',
  );
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
  const nextFinalizeStepDoneCount =
    ownerVerdict === 'step_done'
      ? (task.finalize_step_done_count ?? 0) + 1
      : (task.finalize_step_done_count ?? 0);
  const nextEmptyStepDoneStreak =
    ownerVerdict === 'step_done' && hasNewChanges === false
      ? (task.empty_step_done_streak ?? 0) + 1
      : 0;
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
      expectedUpdatedAt: task.updated_at,
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
      patch: {
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: nextFinalizeStepDoneCount,
        empty_step_done_streak: nextEmptyStepDoneStreak,
      },
    });
    return 'stop';
  }

  if (
    ownerVerdict === 'step_done' &&
    hasNewChanges === false &&
    nextEmptyStepDoneStreak >= EMPTY_STEP_DONE_THRESHOLD
  ) {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage:
        'Owner repeated STEP_DONE during finalize without code changes — requesting arbiter',
      escalateLogMessage:
        'Owner repeated STEP_DONE during finalize without code changes — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        hasNewChanges,
        emptyStepDoneStreak: nextEmptyStepDoneStreak,
        finalizeStepDoneCount: nextFinalizeStepDoneCount,
        summary: summary?.slice(0, 100),
      },
      patch: {
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: nextFinalizeStepDoneCount,
        empty_step_done_streak: nextEmptyStepDoneStreak,
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
        expectedUpdatedAt: task.updated_at,
        updatedAt: now,
        patch: {
          owner_failure_count: 0,
          owner_step_done_streak: 0,
          finalize_step_done_count: nextFinalizeStepDoneCount,
          empty_step_done_streak:
            ownerVerdict === 'step_done' ? nextEmptyStepDoneStreak : 0,
        },
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
        : ownerVerdict === 'step_done'
          ? 'Owner reported STEP_DONE during finalize — task set back to active before review'
          : 'Owner made changes after reviewer approval — task set back to active before re-review',
    );
    maybeAutoTriggerReviewerAfterOwnerCompletion({
      task,
      taskId,
      now,
      logMessage:
        ownerVerdict === 'step_done'
          ? 'Auto-triggered reviewer after owner finalize STEP_DONE'
          : 'Auto-triggered reviewer after owner finalize required re-review',
      patch:
        ownerVerdict === 'step_done'
          ? {
              finalize_step_done_count: nextFinalizeStepDoneCount,
              empty_step_done_streak: nextEmptyStepDoneStreak,
            }
          : undefined,
    });
    return 'stop';
  }

  transitionPairedTaskStatus({
    taskId,
    currentStatus: task.status,
    nextStatus: 'completed',
    expectedUpdatedAt: task.updated_at,
    updatedAt: now,
    patch: {
      completion_reason: 'done',
      owner_failure_count: 0,
      owner_step_done_streak: 0,
      finalize_step_done_count: nextFinalizeStepDoneCount,
      empty_step_done_streak: 0,
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
  patch?: {
    owner_step_done_streak?: number;
    finalize_step_done_count?: number;
    empty_step_done_streak?: number;
  };
}): void {
  const { task, taskId, now, logMessage } = args;
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
    const reviewReadyTask = getPairedTaskById(taskId);
    if (!reviewReadyTask) {
      return;
    }
    applyPairedTaskPatch({
      taskId,
      expectedUpdatedAt: reviewReadyTask.updated_at,
      updatedAt: now,
      patch: {
        round_trip_count: task.round_trip_count + 1,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
        ...args.patch,
      },
    });
    if (hasActiveCiWatcherForChat(task.chat_jid)) {
      logger.info(
        {
          taskId,
          chatJid: task.chat_jid,
          roundTrip: task.round_trip_count + 1,
        },
        'Active CI watcher found, marked task review_ready and deferred reviewer enqueue until watcher completes',
      );
      return;
    }
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
  const workspace = getPairedWorkspace(task.id, 'owner');
  const hasNewChanges = workspace?.workspace_dir
    ? hasCodeChangesSinceRef(workspace.workspace_dir, task.source_ref)
    : null;
  const nextOwnerStepDoneStreak =
    ownerVerdict === 'step_done' ? (task.owner_step_done_streak ?? 0) + 1 : 0;
  const nextEmptyStepDoneStreak =
    ownerVerdict === 'step_done' && hasNewChanges === false
      ? (task.empty_step_done_streak ?? 0) + 1
      : 0;
  const signal = resolveOwnerCompletionSignal({
    phase: 'normal',
    visibleVerdict: ownerVerdict,
  });

  if (signal.kind === 'request_arbiter') {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage: 'Owner blocked/needs_context — requesting arbiter',
      escalateLogMessage: 'Owner blocked/needs_context — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        ownerStepDoneStreak: nextOwnerStepDoneStreak,
        summary: summary?.slice(0, 100),
      },
      patch: {
        owner_failure_count: 0,
        owner_step_done_streak: nextOwnerStepDoneStreak,
      },
    });
    return;
  }

  if (
    ownerVerdict === 'step_done' &&
    hasNewChanges === false &&
    nextEmptyStepDoneStreak >= EMPTY_STEP_DONE_THRESHOLD
  ) {
    requestArbiterOrEscalate({
      taskId,
      currentStatus: task.status,
      expectedUpdatedAt: task.updated_at,
      now,
      arbiterLogMessage:
        'Owner repeated STEP_DONE without code changes — requesting arbiter',
      escalateLogMessage:
        'Owner repeated STEP_DONE without code changes — escalating to user',
      logContext: {
        taskId,
        ownerVerdict,
        hasNewChanges,
        ownerStepDoneStreak: nextOwnerStepDoneStreak,
        emptyStepDoneStreak: nextEmptyStepDoneStreak,
        summary: summary?.slice(0, 100),
      },
      patch: {
        owner_failure_count: 0,
        owner_step_done_streak: nextOwnerStepDoneStreak,
        empty_step_done_streak: nextEmptyStepDoneStreak,
      },
    });
    return;
  }

  if (nextOwnerStepDoneStreak !== (task.owner_step_done_streak ?? 0)) {
    applyPairedTaskPatch({
      taskId,
      expectedUpdatedAt: task.updated_at,
      updatedAt: now,
      patch: {
        owner_step_done_streak: nextOwnerStepDoneStreak,
        empty_step_done_streak: nextEmptyStepDoneStreak,
      },
    });
  }
  maybeAutoTriggerReviewerAfterOwnerCompletion({
    task,
    taskId,
    now,
    logMessage: 'Auto-triggered reviewer after owner completion',
    patch: {
      owner_step_done_streak: nextOwnerStepDoneStreak,
      empty_step_done_streak: nextEmptyStepDoneStreak,
    },
  });
}
