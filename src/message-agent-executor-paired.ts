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
import { isHumanMessageCloseReason } from './message-close-reasons.js';
import { persistPairedTurnOutputAttachments } from './paired-turn-output-attachments.js';
import type { OutboundAttachment, PairedRoomRole } from './types.js';

type ExecutorLog = Pick<typeof logger, 'info' | 'warn'>;

const PAIRED_TASK_EXECUTION_LEASE_HEARTBEAT_MS = 30_000;

type PairedTaskRecord = NonNullable<ReturnType<typeof getPairedTaskById>>;

function releaseInterruptedPairedExecution(
  taskId: string,
  runId: string,
  log: ExecutorLog,
): void {
  log.info(
    { pairedTaskId: taskId, runId },
    'Released paired execution lease without counting a failure because a human message interrupted the turn',
  );
  try {
    releasePairedTaskExecutionLease({ taskId, runId });
  } catch (err) {
    log.warn(
      { pairedTaskId: taskId, runId, err },
      'Failed to release paired execution lease after human interruption',
    );
  }
}

function completeStoredExecution(
  taskId: string,
  role: PairedRoomRole,
  status: 'succeeded' | 'failed',
  runId: string,
  summary: string | null,
): void {
  completePairedExecutionContext({
    taskId,
    role,
    status,
    runId,
    summary,
  });
}

async function notifyPairedCompletionIfNeeded(args: {
  task: PairedTaskRecord | null | undefined;
  chatJid: string;
  onOutput?: (output: AgentOutput) => Promise<void>;
}): Promise<void> {
  if (args.task?.status !== 'completed' || !args.task.completion_reason) return;
  const sender = getLastHumanMessageSender(args.chatJid);
  const mention = sender ? `<@${sender}>` : '';
  const notifications: Record<string, string> = {
    escalated: `${mention} ⚠️ 자동 해결 불가 — 확인이 필요합니다.`,
  };
  const message = notifications[args.task.completion_reason];
  if (!message) return;
  await args.onOutput?.({
    status: 'success',
    result: message,
    output: { visibility: 'public', text: message },
    phase: 'final',
  });
}

export interface PairedExecutionLifecycle {
  updateSummary(args: {
    outputText?: string | null;
    errorText?: string | null;
  }): void;
  recordFinalOutputBeforeDelivery(
    outputText: string,
    attachments?: OutboundAttachment[],
  ): boolean;
  completeImmediately(args: { status: 'succeeded' | 'failed' }): void;
  markDelegated(): void;
  markStatus(status: 'succeeded' | 'failed'): void;
  markSawOutput(sawOutput: boolean): void;
  getSummary(): string | null;
  asyncFinalize(): Promise<void>;
}

interface CreatePairedExecutionLifecycleArgs {
  pairedExecutionContext?: PreparedPairedExecutionContext;
  pairedTurnIdentity?: PairedTurnIdentity;
  completedRole: PairedRoomRole;
  chatJid: string;
  runId: string;
  enqueueMessageCheck: () => void;
  getDirectTerminalDeliveryText?: () => string | null;
  getCloseReason?: () => string | null;
  onOutput?: (output: AgentOutput) => Promise<void>;
  log: ExecutorLog;
}

type PairedExecutionStatus = 'succeeded' | 'failed';

interface FinalizeState {
  directTerminalOutput: string | null;
  effectiveStatus: PairedExecutionStatus;
  sawOutputForFollowUp: boolean;
  interruptedByHumanMessage: boolean;
}

class PairedExecutionLifecycleController implements PairedExecutionLifecycle {
  private pairedExecutionStatus: PairedExecutionStatus = 'failed';
  private pairedExecutionSummary: string | null = null;
  private pairedFinalOutput: string | null = null;
  private pairedFinalAttachments: OutboundAttachment[] = [];
  private pairedSummaryLocked = false;
  private pairedExecutionCompleted = false;
  private pairedExecutionDelegated = false;
  private pairedSawOutput = false;
  private pairedTurnOutputPersisted = false;
  private pairedTurnStateFinalized = false;
  private leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly args: CreatePairedExecutionLifecycleArgs) {
    if (!this.args.pairedExecutionContext) {
      return;
    }
    this.leaseHeartbeatTimer = setInterval(
      () => this.heartbeatLeaseIfNeeded(),
      PAIRED_TASK_EXECUTION_LEASE_HEARTBEAT_MS,
    );
    this.leaseHeartbeatTimer.unref?.();
  }

  updateSummary({
    outputText,
    errorText,
  }: {
    outputText?: string | null;
    errorText?: string | null;
  }): void {
    if (this.pairedSummaryLocked) {
      return;
    }

    if (outputText && outputText.length > 0) {
      this.pairedExecutionSummary = outputText.slice(0, 500);
      return;
    }

    if (errorText && errorText.length > 0) {
      this.pairedExecutionSummary = errorText.slice(0, 500);
    }
  }

  recordFinalOutputBeforeDelivery(
    outputText: string,
    attachments: OutboundAttachment[] = [],
  ): boolean {
    if (this.wasInterruptedByHumanMessage()) return false;
    if (!this.currentRunOwnsActiveAttempt('streamed-final-output')) {
      return false;
    }
    this.lockVisibleVerdict(outputText, attachments);
    this.completeSuccessfulOwnerTurnBeforeDeliveryIfNeeded();
    this.persistPairedTurnOutputIfNeeded();
    return true;
  }

  completeImmediately({ status }: { status: PairedExecutionStatus }): void {
    const { completedRole, pairedExecutionContext, runId } = this.args;
    if (!pairedExecutionContext || this.pairedExecutionCompleted) {
      return;
    }

    this.pairedExecutionStatus = status;
    if (status === 'succeeded') {
      this.persistPairedTurnOutputIfNeeded();
    }

    this.clearLeaseHeartbeat();
    completePairedExecutionContext({
      taskId: pairedExecutionContext.task.id,
      role: completedRole,
      status,
      runId,
      summary: this.pairedExecutionSummary,
    });
    this.pairedExecutionCompleted = true;
  }

  markDelegated(): void {
    this.pairedExecutionDelegated = true;
  }

  markStatus(status: PairedExecutionStatus): void {
    this.pairedExecutionStatus = status;
  }

  markSawOutput(sawOutput: boolean): void {
    this.pairedSawOutput = sawOutput;
  }

  getSummary(): string | null {
    return this.pairedExecutionSummary;
  }

  async asyncFinalize(): Promise<void> {
    this.clearLeaseHeartbeat();

    if (!this.currentRunOwnsActiveAttempt('async-finalize')) {
      return;
    }

    if (this.releaseDelegatedExecutionIfNeeded()) {
      return;
    }

    const state = this.resolveFinalizeState();
    this.completeStoredExecutionIfNeeded(state);
    this.finalizePairedTurnState(
      state.effectiveStatus,
      state.effectiveStatus === 'failed' ? this.pairedExecutionSummary : null,
    );

    await this.notifyCompletionAndQueueFollowUp(state);
  }

  private wasInterruptedByHumanMessage(): boolean {
    return isHumanMessageCloseReason(this.args.getCloseReason?.() ?? null);
  }

  private currentRunOwnsActiveAttempt(reason: string): boolean {
    const { log, pairedExecutionContext, pairedTurnIdentity, runId } =
      this.args;
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
  }

  private finalizePairedTurnState(
    status: 'succeeded' | 'failed',
    errorText?: string | null,
  ): void {
    const { pairedTurnIdentity } = this.args;
    if (!pairedTurnIdentity || this.pairedTurnStateFinalized) {
      return;
    }
    if (status === 'succeeded') {
      completePairedTurn(pairedTurnIdentity);
    } else {
      failPairedTurn({
        turnIdentity: pairedTurnIdentity,
        error: errorText ?? this.pairedExecutionSummary,
      });
    }
    this.pairedTurnStateFinalized = true;
  }

  private clearLeaseHeartbeat(): void {
    if (!this.leaseHeartbeatTimer) {
      return;
    }
    clearInterval(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = null;
  }

  private heartbeatLeaseIfNeeded(): void {
    const { pairedExecutionContext, runId, log } = this.args;
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
  }

  private persistPairedTurnOutputIfNeeded(): void {
    const { completedRole, pairedExecutionContext } = this.args;
    if (
      !pairedExecutionContext ||
      this.pairedTurnOutputPersisted ||
      !this.pairedFinalOutput ||
      this.pairedFinalOutput.length === 0
    ) {
      return;
    }

    const turnNumber = getLatestTurnNumber(pairedExecutionContext.task.id) + 1;
    const attachments =
      this.pairedFinalAttachments.length > 0
        ? persistPairedTurnOutputAttachments({
            taskId: pairedExecutionContext.task.id,
            turnNumber,
            role: completedRole,
            attachments: this.pairedFinalAttachments,
          })
        : [];
    if (attachments.length > 0) {
      insertPairedTurnOutput(
        pairedExecutionContext.task.id,
        turnNumber,
        completedRole,
        this.pairedFinalOutput,
        { attachments },
      );
    } else {
      insertPairedTurnOutput(
        pairedExecutionContext.task.id,
        turnNumber,
        completedRole,
        this.pairedFinalOutput,
      );
    }
    this.pairedTurnOutputPersisted = true;
  }

  private completeSuccessfulOwnerTurnBeforeDeliveryIfNeeded(): void {
    const { completedRole, pairedExecutionContext, runId } = this.args;
    if (
      completedRole !== 'owner' ||
      !pairedExecutionContext ||
      this.pairedExecutionCompleted ||
      !this.pairedFinalOutput ||
      this.pairedFinalOutput.length === 0
    ) {
      return;
    }

    this.pairedExecutionStatus = 'succeeded';
    this.pairedSawOutput = true;
    this.persistPairedTurnOutputIfNeeded();
    this.clearLeaseHeartbeat();
    completePairedExecutionContext({
      taskId: pairedExecutionContext.task.id,
      role: completedRole,
      status: 'succeeded',
      runId,
      summary: this.pairedExecutionSummary,
    });
    this.pairedExecutionCompleted = true;
  }

  private lockVisibleVerdict(
    outputText: string,
    attachments: OutboundAttachment[] = [],
  ): void {
    if (outputText.length === 0) {
      return;
    }
    if (!this.pairedFinalOutput || this.pairedFinalOutput.length === 0) {
      this.pairedFinalOutput = outputText;
      this.pairedFinalAttachments = attachments;
    }
    if (!this.pairedSummaryLocked) {
      this.pairedExecutionSummary = outputText.slice(0, 500);
      this.pairedSummaryLocked = true;
    }
    this.pairedSawOutput = true;
  }

  private adoptDirectTerminalDeliveryIfNeeded(): string | null {
    const {
      completedRole,
      getDirectTerminalDeliveryText,
      log,
      pairedExecutionContext,
      runId,
    } = this.args;
    const outputText = getDirectTerminalDeliveryText?.();
    if (!outputText || outputText.length === 0) {
      return null;
    }
    if (!this.pairedFinalOutput || this.pairedFinalOutput.length === 0) {
      this.lockVisibleVerdict(outputText);
      log.info(
        {
          pairedTaskId: pairedExecutionContext?.task.id ?? null,
          role: completedRole,
          runId,
        },
        'Adopted direct terminal delivery as paired final output',
      );
    } else if (!this.pairedSummaryLocked) {
      this.pairedExecutionSummary = this.pairedFinalOutput.slice(0, 500);
      this.pairedSummaryLocked = true;
    }
    return outputText;
  }

  private releaseDelegatedExecutionIfNeeded(): boolean {
    const { log, pairedExecutionContext, runId } = this.args;
    if (!pairedExecutionContext || !this.pairedExecutionDelegated) {
      return false;
    }
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
    this.pairedExecutionCompleted = true;
    return true;
  }

  private resolveFinalizeState(): FinalizeState {
    const directTerminalOutput = this.adoptDirectTerminalDeliveryIfNeeded();
    const missingVisibleVerdict = this.resolveMissingVisibleVerdict();
    const effectiveStatus = this.resolveEffectiveStatus(missingVisibleVerdict);
    const sawOutputForFollowUp = missingVisibleVerdict
      ? false
      : this.pairedSawOutput;

    return {
      directTerminalOutput,
      effectiveStatus,
      sawOutputForFollowUp,
      interruptedByHumanMessage: this.wasInterruptedByHumanMessage(),
    };
  }

  private resolveMissingVisibleVerdict(): boolean {
    const { completedRole, log, pairedExecutionContext, runId } = this.args;
    const missingVisibleVerdict =
      pairedExecutionContext?.requiresVisibleVerdict === true &&
      (!this.pairedFinalOutput || this.pairedFinalOutput.length === 0);
    if (!missingVisibleVerdict) {
      return false;
    }
    this.pairedExecutionSummary =
      'Execution completed without a visible terminal verdict.';
    log.warn(
      {
        pairedTaskId: pairedExecutionContext?.task.id ?? null,
        role: completedRole,
        runId,
      },
      'Treating paired execution as failed because it ended without a visible terminal verdict',
    );
    return true;
  }

  private resolveEffectiveStatus(
    missingVisibleVerdict: boolean,
  ): PairedExecutionStatus {
    if (
      this.args.completedRole === 'owner' &&
      this.pairedExecutionStatus === 'succeeded' &&
      !this.pairedSawOutput
    ) {
      return 'failed';
    }
    if (missingVisibleVerdict && this.pairedExecutionStatus === 'succeeded') {
      return 'failed';
    }
    return this.pairedExecutionStatus;
  }

  private completeStoredExecutionIfNeeded(state: FinalizeState): void {
    const { completedRole, log, pairedExecutionContext, runId } = this.args;
    if (!pairedExecutionContext || this.pairedExecutionCompleted) {
      return;
    }
    if (state.interruptedByHumanMessage) {
      releaseInterruptedPairedExecution(
        pairedExecutionContext.task.id,
        runId,
        log,
      );
      this.pairedExecutionCompleted = true;
      return;
    }
    this.persistSuccessfulOutputBeforeCompletion(state.effectiveStatus);
    completeStoredExecution(
      pairedExecutionContext.task.id,
      completedRole,
      state.effectiveStatus,
      runId,
      this.pairedExecutionSummary,
    );
    this.pairedExecutionCompleted = true;
  }

  private persistSuccessfulOutputBeforeCompletion(
    effectiveStatus: PairedExecutionStatus,
  ): void {
    if (effectiveStatus !== 'succeeded') {
      return;
    }
    try {
      this.persistPairedTurnOutputIfNeeded();
    } catch (err) {
      this.args.log.warn(
        { pairedTaskId: this.args.pairedExecutionContext?.task.id, err },
        'Failed to store paired turn output',
      );
    }
  }

  private async notifyCompletionAndQueueFollowUp(
    state: FinalizeState,
  ): Promise<void> {
    const { chatJid, onOutput, pairedExecutionContext } = this.args;
    if (!pairedExecutionContext || state.interruptedByHumanMessage) {
      return;
    }
    const finishedTask = getPairedTaskById(pairedExecutionContext.task.id);
    await notifyPairedCompletionIfNeeded({
      task: finishedTask,
      chatJid,
      onOutput,
    });
    this.queueFollowUpIfNeeded(state, finishedTask);
  }

  private queueFollowUpIfNeeded(
    state: FinalizeState,
    finishedTask: PairedTaskRecord | null | undefined,
  ): void {
    const queueAction = this.resolveQueueAction(state, finishedTask);
    if (queueAction !== 'pending' || !finishedTask) {
      return;
    }
    const followUpResult = this.enqueueFollowUp(state, finishedTask);
    this.logFollowUpResult(followUpResult, state, finishedTask);
  }

  private resolveQueueAction(
    state: FinalizeState,
    finishedTask: PairedTaskRecord | null | undefined,
  ): ReturnType<typeof resolvePairedFollowUpQueueAction> | 'none' {
    const { completedRole } = this.args;
    if (
      state.directTerminalOutput &&
      (completedRole === 'reviewer' || completedRole === 'arbiter')
    ) {
      return 'none';
    }
    return resolvePairedFollowUpQueueAction({
      completedRole,
      executionStatus: state.effectiveStatus,
      sawOutput: state.sawOutputForFollowUp,
      taskStatus: finishedTask?.status ?? null,
      outputSummary: this.pairedExecutionSummary,
    });
  }

  private enqueueFollowUp(
    state: FinalizeState,
    finishedTask: PairedTaskRecord,
  ): ReturnType<typeof enqueuePairedFollowUpAfterEvent> {
    const { chatJid, completedRole, enqueueMessageCheck, runId } = this.args;
    return enqueuePairedFollowUpAfterEvent({
      chatJid,
      runId,
      task: finishedTask,
      source: 'executor-recovery',
      completedRole,
      executionStatus: state.effectiveStatus,
      sawOutput: state.sawOutputForFollowUp,
      fallbackLastTurnOutputRole: state.sawOutputForFollowUp
        ? completedRole
        : null,
      fallbackLastTurnOutputVerdict:
        state.sawOutputForFollowUp && this.pairedExecutionSummary
          ? parseVisibleVerdict(this.pairedExecutionSummary)
          : null,
      enqueueMessageCheck,
    });
  }

  private logFollowUpResult(
    followUpResult: ReturnType<typeof enqueuePairedFollowUpAfterEvent>,
    state: FinalizeState,
    finishedTask: PairedTaskRecord,
  ): void {
    const { completedRole, log, pairedExecutionContext } = this.args;
    if (followUpResult.kind !== 'paired-follow-up') {
      return;
    }
    log.info(
      {
        taskId: pairedExecutionContext?.task.id,
        role: completedRole,
        pairedExecutionStatus: state.effectiveStatus,
        taskStatus: finishedTask.status,
        intentKind: followUpResult.intentKind,
        scheduled: followUpResult.scheduled,
      },
      followUpResult.scheduled
        ? 'Queued paired follow-up after failed reviewer/arbiter execution left a pending task state'
        : 'Skipped duplicate paired follow-up after failed reviewer/arbiter execution while task state was unchanged',
    );
  }
}

export function createPairedExecutionLifecycle(
  args: CreatePairedExecutionLifecycleArgs,
): PairedExecutionLifecycle {
  return new PairedExecutionLifecycleController(args);
}
