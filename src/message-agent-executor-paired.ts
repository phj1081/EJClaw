import type { AgentOutput } from './agent-runner.js';
import {
  getLastHumanMessageSender,
  getLatestTurnNumber,
  getPairedTaskById,
  insertPairedTurnOutput,
  refreshPairedTaskExecutionLease,
} from './db.js';
import { logger } from './logger.js';
import {
  completePairedExecutionContext,
  type PreparedPairedExecutionContext,
} from './paired-execution-context.js';
import { resolvePairedFollowUpQueueAction } from './message-agent-executor-rules.js';
import { enqueuePairedFollowUpAfterEvent } from './message-runtime-follow-up.js';
import type { PairedRoomRole } from './types.js';

type ExecutorLog = Pick<typeof logger, 'info' | 'warn'>;

const PAIRED_TASK_EXECUTION_LEASE_HEARTBEAT_MS = 30_000;

export interface PairedExecutionLifecycle {
  updateSummary(args: {
    outputText?: string | null;
    errorText?: string | null;
  }): void;
  recordFinalOutputBeforeDelivery(outputText: string): void;
  completeImmediately(args: { status: 'succeeded' | 'failed' }): void;
  markStatus(status: 'succeeded' | 'failed'): void;
  markSawOutput(sawOutput: boolean): void;
  getSummary(): string | null;
  asyncFinalize(): Promise<void>;
}

export function createPairedExecutionLifecycle(args: {
  pairedExecutionContext?: PreparedPairedExecutionContext;
  completedRole: PairedRoomRole;
  chatJid: string;
  runId: string;
  enqueueMessageCheck: () => void;
  onOutput?: (output: AgentOutput) => Promise<void>;
  log: ExecutorLog;
}): PairedExecutionLifecycle {
  const {
    pairedExecutionContext,
    completedRole,
    chatJid,
    runId,
    enqueueMessageCheck,
    onOutput,
    log,
  } = args;

  let pairedExecutionStatus: 'succeeded' | 'failed' = 'failed';
  let pairedExecutionSummary: string | null = null;
  let pairedFinalOutput: string | null = null;
  let pairedExecutionCompleted = false;
  let pairedSawOutput = false;
  let pairedTurnOutputPersisted = false;
  let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

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

  return {
    updateSummary({ outputText, errorText }) {
      if (outputText && outputText.length > 0) {
        pairedExecutionSummary = outputText.slice(0, 500);
        return;
      }

      if (errorText && errorText.length > 0) {
        pairedExecutionSummary = errorText.slice(0, 500);
      }
    },

    recordFinalOutputBeforeDelivery(outputText) {
      pairedFinalOutput = outputText;
      completeSuccessfulOwnerTurnBeforeDeliveryIfNeeded();
      persistPairedTurnOutputIfNeeded();
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

      if (pairedExecutionContext && !pairedExecutionCompleted) {
        const effectiveStatus =
          completedRole === 'owner' &&
          pairedExecutionStatus === 'succeeded' &&
          !pairedSawOutput
            ? 'failed'
            : pairedExecutionStatus;

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
          done: `${mention} ✅ 작업 완료.`,
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

      const queueAction = resolvePairedFollowUpQueueAction({
        completedRole,
        executionStatus: pairedExecutionStatus,
        sawOutput: pairedSawOutput,
        taskStatus: finishedTask?.status ?? null,
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
        executionStatus: pairedExecutionStatus,
        sawOutput: pairedSawOutput,
        fallbackLastTurnOutputRole: pairedSawOutput ? completedRole : null,
        enqueueMessageCheck,
      });
      if (followUpResult.kind !== 'paired-follow-up') {
        return;
      }
      log.info(
        {
          taskId: pairedExecutionContext.task.id,
          role: completedRole,
          pairedExecutionStatus,
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
