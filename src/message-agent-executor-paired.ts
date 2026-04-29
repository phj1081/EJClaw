import type { AgentOutput } from './agent-runner.js';
import {
  completePairedTurn,
  failPairedTurn,
  getLastHumanMessageSender,
  getLatestTurnNumber,
  getPairedTaskById,
  insertPairedTurnOutput,
  refreshPairedTaskExecutionLease,
  releasePairedTaskExecutionLease,
} from './db.js';
import { logger } from './logger.js';
import {
  completePairedExecutionContext,
  type PreparedPairedExecutionContext,
} from './paired-execution-context.js';
import { parseVisibleVerdict } from './paired-verdict.js';
import { resolvePairedFollowUpQueueAction } from './message-agent-executor-rules.js';
import { enqueuePairedFollowUpAfterEvent } from './message-runtime-follow-up.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';
import { resolvePairedTurnRunOwnership } from './paired-turn-run-ownership.js';
import type { PairedRoomRole } from './types.js';

type ExecutorLog = Pick<typeof logger, 'info' | 'warn'>;

const PAIRED_TASK_EXECUTION_LEASE_HEARTBEAT_MS = 30_000;

export interface PairedExecutionLifecycle {
  updateSummary(args: {
    outputText?: string | null;
    errorText?: string | null;
  }): void;
  recordFinalOutputBeforeDelivery(outputText: string): boolean;
  completeImmediately(args: { status: 'succeeded' | 'failed' }): void;
  markDelegated(): void;
  markStatus(status: 'succeeded' | 'failed'): void;
  markSawOutput(sawOutput: boolean): void;
  getSummary(): string | null;
  asyncFinalize(): Promise<void>;
}

export function createPairedExecutionLifecycle(args: {
  pairedExecutionContext?: PreparedPairedExecutionContext;
  pairedTurnIdentity?: PairedTurnIdentity;
  completedRole: PairedRoomRole;
  chatJid: string;
  runId: string;
  enqueueMessageCheck: () => void;
  getDirectTerminalDeliveryText?: () => string | null;
  onOutput?: (output: AgentOutput) => Promise<void>;
  log: ExecutorLog;
}): PairedExecutionLifecycle {
  const {
    pairedExecutionContext,
    pairedTurnIdentity,
    completedRole,
    chatJid,
    runId,
    enqueueMessageCheck,
    getDirectTerminalDeliveryText,
    onOutput,
    log,
  } = args;

  let pairedExecutionStatus: 'succeeded' | 'failed' = 'failed';
  let pairedExecutionSummary: string | null = null;
  let pairedFinalOutput: string | null = null;
  let pairedSummaryLocked = false;
  let pairedExecutionCompleted = false;
  let pairedExecutionDelegated = false;
  let pairedSawOutput = false;
  let pairedTurnOutputPersisted = false;
  let pairedTurnStateFinalized = false;
  let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const requiresVisibleVerdict =
    pairedExecutionContext?.requiresVisibleVerdict === true;
  const missingVisibleVerdictSummary =
    'Execution completed without a visible terminal verdict.';

  const currentRunOwnsActiveAttempt = (reason: string): boolean => {
    if (!pairedTurnIdentity) {
      return true;
    }
    const ownership = resolvePairedTurnRunOwnership({
      turnId: pairedTurnIdentity.turnId,
      runId,
    });
    if (ownership.state === 'active') {
      return true;
    }
    if (ownership.state === 'missing') {
      log.warn(
        {
          pairedTaskId: pairedExecutionContext?.task.id ?? null,
          turnId: pairedTurnIdentity.turnId,
          runId,
          reason,
        },
        'Could not verify paired turn attempt ownership before final side effects; keeping legacy behavior',
      );
      return true;
    }
    log.warn(
      {
        pairedTaskId: pairedExecutionContext?.task.id ?? null,
        turnId: pairedTurnIdentity.turnId,
        runId,
        reason,
        currentAttemptNo: ownership.currentAttemptNo,
        currentAttemptState: ownership.currentAttemptState,
        currentAttemptRunId: ownership.currentAttemptRunId,
      },
      'Skipping paired final side effects because this run no longer owns the active attempt',
    );
    return false;
  };

  const finalizePairedTurnState = (
    status: 'succeeded' | 'failed',
    errorText?: string | null,
  ) => {
    if (!pairedTurnIdentity || pairedTurnStateFinalized) {
      return;
    }
    if (status === 'succeeded') {
      completePairedTurn(pairedTurnIdentity);
    } else {
      failPairedTurn({
        turnIdentity: pairedTurnIdentity,
        error: errorText ?? pairedExecutionSummary,
      });
    }
    pairedTurnStateFinalized = true;
  };

  const clearLeaseHeartbeat = () => {
    if (!leaseHeartbeatTimer) {
      return;
    }
    clearInterval(leaseHeartbeatTimer);
    leaseHeartbeatTimer = null;
  };
  const heartbeatLeaseIfNeeded = () => {
    if (!pairedExecutionContext) {
      return;
    }
    try {
      const refreshed = refreshPairedTaskExecutionLease({
        taskId: pairedExecutionContext.task.id,
        runId,
      });
      if (!refreshed) {
        log.warn(
          {
            pairedTaskId: pairedExecutionContext.task.id,
            runId,
          },
          'Skipped paired execution lease heartbeat because this run no longer owns the lease',
        );
      }
    } catch (err) {
      log.warn(
        {
          pairedTaskId: pairedExecutionContext.task.id,
          runId,
          err,
        },
        'Failed to refresh paired execution lease heartbeat',
      );
    }
  };

  if (pairedExecutionContext) {
    leaseHeartbeatTimer = setInterval(
      heartbeatLeaseIfNeeded,
      PAIRED_TASK_EXECUTION_LEASE_HEARTBEAT_MS,
    );
    leaseHeartbeatTimer.unref?.();
  }

  const persistPairedTurnOutputIfNeeded = () => {
    if (
      !pairedExecutionContext ||
      pairedTurnOutputPersisted ||
      !pairedFinalOutput ||
      pairedFinalOutput.length === 0
    ) {
      return;
    }

    const turnNumber = getLatestTurnNumber(pairedExecutionContext.task.id) + 1;
    insertPairedTurnOutput(
      pairedExecutionContext.task.id,
      turnNumber,
      completedRole,
      pairedFinalOutput,
    );
    pairedTurnOutputPersisted = true;
  };

  const completeSuccessfulOwnerTurnBeforeDeliveryIfNeeded = () => {
    if (
      completedRole !== 'owner' ||
      !pairedExecutionContext ||
      pairedExecutionCompleted ||
      !pairedFinalOutput ||
      pairedFinalOutput.length === 0
    ) {
      return;
    }

    pairedExecutionStatus = 'succeeded';
    pairedSawOutput = true;
    persistPairedTurnOutputIfNeeded();
    clearLeaseHeartbeat();
    completePairedExecutionContext({
      taskId: pairedExecutionContext.task.id,
      role: completedRole,
      status: 'succeeded',
      runId,
      summary: pairedExecutionSummary,
    });
    pairedExecutionCompleted = true;
  };

  const lockVisibleVerdict = (outputText: string) => {
    if (outputText.length === 0) {
      return;
    }
    if (!pairedFinalOutput || pairedFinalOutput.length === 0) {
      pairedFinalOutput = outputText;
    }
    if (!pairedSummaryLocked) {
      pairedExecutionSummary = outputText.slice(0, 500);
      pairedSummaryLocked = true;
    }
    pairedSawOutput = true;
  };

  const adoptDirectTerminalDeliveryIfNeeded = () => {
    const outputText = getDirectTerminalDeliveryText?.();
    if (!outputText || outputText.length === 0) {
      return null;
    }
    if (!pairedFinalOutput || pairedFinalOutput.length === 0) {
      lockVisibleVerdict(outputText);
      log.info(
        {
          pairedTaskId: pairedExecutionContext?.task.id ?? null,
          role: completedRole,
          runId,
        },
        'Adopted direct terminal delivery as paired final output',
      );
    } else if (!pairedSummaryLocked) {
      pairedExecutionSummary = pairedFinalOutput.slice(0, 500);
      pairedSummaryLocked = true;
    }
    return outputText;
  };

  return {
    updateSummary({ outputText, errorText }) {
      if (pairedSummaryLocked) {
        return;
      }

      if (outputText && outputText.length > 0) {
        pairedExecutionSummary = outputText.slice(0, 500);
        return;
      }

      if (errorText && errorText.length > 0) {
        pairedExecutionSummary = errorText.slice(0, 500);
      }
    },

    recordFinalOutputBeforeDelivery(outputText) {
      if (!currentRunOwnsActiveAttempt('streamed-final-output')) {
        return false;
      }
      lockVisibleVerdict(outputText);
      completeSuccessfulOwnerTurnBeforeDeliveryIfNeeded();
      persistPairedTurnOutputIfNeeded();
      return true;
    },

    completeImmediately({ status }) {
      if (!pairedExecutionContext || pairedExecutionCompleted) {
        return;
      }

      pairedExecutionStatus = status;
      if (status === 'succeeded') {
        persistPairedTurnOutputIfNeeded();
      }

      clearLeaseHeartbeat();
      completePairedExecutionContext({
        taskId: pairedExecutionContext.task.id,
        role: completedRole,
        status,
        runId,
        summary: pairedExecutionSummary,
      });
      pairedExecutionCompleted = true;
    },

    markDelegated() {
      pairedExecutionDelegated = true;
    },

    markStatus(status) {
      pairedExecutionStatus = status;
    },

    markSawOutput(sawOutput) {
      pairedSawOutput = sawOutput;
    },

    getSummary() {
      return pairedExecutionSummary;
    },

    async asyncFinalize() {
      clearLeaseHeartbeat();

      if (!currentRunOwnsActiveAttempt('async-finalize')) {
        return;
      }

      if (pairedExecutionContext && pairedExecutionDelegated) {
        try {
          releasePairedTaskExecutionLease({
            taskId: pairedExecutionContext.task.id,
            runId,
          });
        } catch (err) {
          log.warn(
            {
              pairedTaskId: pairedExecutionContext.task.id,
              runId,
              err,
            },
            'Failed to release paired execution lease for delegated fallback handoff',
          );
        }
        pairedExecutionCompleted = true;
        return;
      }

      const directTerminalOutput = adoptDirectTerminalDeliveryIfNeeded();

      const missingVisibleVerdict =
        requiresVisibleVerdict &&
        (!pairedFinalOutput || pairedFinalOutput.length === 0);
      if (missingVisibleVerdict) {
        pairedExecutionSummary = missingVisibleVerdictSummary;
        log.warn(
          {
            pairedTaskId: pairedExecutionContext?.task.id ?? null,
            role: completedRole,
            runId,
          },
          'Treating paired execution as failed because it ended without a visible terminal verdict',
        );
      }
      const effectiveStatus =
        completedRole === 'owner' &&
        pairedExecutionStatus === 'succeeded' &&
        !pairedSawOutput
          ? 'failed'
          : missingVisibleVerdict && pairedExecutionStatus === 'succeeded'
            ? 'failed'
            : pairedExecutionStatus;
      const sawOutputForFollowUp = missingVisibleVerdict
        ? false
        : pairedSawOutput;

      if (pairedExecutionContext && !pairedExecutionCompleted) {
        if (effectiveStatus === 'succeeded') {
          try {
            persistPairedTurnOutputIfNeeded();
          } catch (err) {
            log.warn(
              { pairedTaskId: pairedExecutionContext.task.id, err },
              'Failed to store paired turn output',
            );
          }
        }

        completePairedExecutionContext({
          taskId: pairedExecutionContext.task.id,
          role: completedRole,
          status: effectiveStatus,
          runId,
          summary: pairedExecutionSummary,
        });
        pairedExecutionCompleted = true;
      }

      finalizePairedTurnState(
        effectiveStatus,
        effectiveStatus === 'failed' ? pairedExecutionSummary : null,
      );

      if (!pairedExecutionContext) {
        return;
      }

      const finishedTask = getPairedTaskById(pairedExecutionContext.task.id);
      if (
        finishedTask?.status === 'completed' &&
        finishedTask.completion_reason
      ) {
        const sender = getLastHumanMessageSender(chatJid);
        const mention = sender ? `<@${sender}>` : '';
        const notifications: Record<string, string> = {
          escalated: `${mention} ⚠️ 자동 해결 불가 — 확인이 필요합니다.`,
          arbiter_escalated: `${mention} ⚠️ 중재자 판단: 사람 개입이 필요합니다.`,
        };
        const message = notifications[finishedTask.completion_reason];
        if (message) {
          await onOutput?.({
            status: 'success',
            result: message,
            output: { visibility: 'public', text: message },
            phase: 'final',
          });
        }
      }

      const queueAction =
        directTerminalOutput &&
        (completedRole === 'reviewer' || completedRole === 'arbiter')
          ? 'none'
          : resolvePairedFollowUpQueueAction({
              completedRole,
              executionStatus: effectiveStatus,
              sawOutput: sawOutputForFollowUp,
              taskStatus: finishedTask?.status ?? null,
              outputSummary: pairedExecutionSummary,
            });
      if (queueAction !== 'pending' || !finishedTask) {
        return;
      }

      const followUpResult = enqueuePairedFollowUpAfterEvent({
        chatJid,
        runId,
        task: finishedTask,
        source: 'executor-recovery',
        completedRole,
        executionStatus: effectiveStatus,
        sawOutput: sawOutputForFollowUp,
        fallbackLastTurnOutputRole: sawOutputForFollowUp ? completedRole : null,
        fallbackLastTurnOutputVerdict:
          sawOutputForFollowUp && pairedExecutionSummary
            ? parseVisibleVerdict(pairedExecutionSummary)
            : null,
        enqueueMessageCheck,
      });
      if (followUpResult.kind !== 'paired-follow-up') {
        return;
      }
      log.info(
        {
          taskId: pairedExecutionContext.task.id,
          role: completedRole,
          pairedExecutionStatus: effectiveStatus,
          taskStatus: finishedTask.status,
          intentKind: followUpResult.intentKind,
          scheduled: followUpResult.scheduled,
        },
        followUpResult.scheduled
          ? 'Queued paired follow-up after failed reviewer/arbiter execution left a pending task state'
          : 'Skipped duplicate paired follow-up after failed reviewer/arbiter execution while task state was unchanged',
      );
    },
  };
}
