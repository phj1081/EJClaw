import { getAgentOutputText } from './agent-output.js';
import {
  executeAttemptRetryAction,
  runClaudeAttemptWithRotation,
  runCodexAttemptWithRotation,
} from './agent-attempt-orchestration.js';
import { isRetryableClaudeSessionFailureAttempt } from './agent-attempt-retry.js';
import { getCodexAccountCount } from './codex-token-rotation.js';
import type {
  AgentTriggerReason,
  CodexRotationReason,
} from './agent-error-detection.js';
import type { PairedExecutionLifecycle } from './message-agent-executor-paired.js';
import type { MessageAgentAttempt } from './message-agent-executor-attempt-runner.js';
import {
  shouldResetCodexSessionOnAgentFailure,
  shouldResetSessionOnAgentFailure,
  shouldRetryFreshCodexSessionOnAgentFailure,
} from './session-recovery.js';
import { getErrorMessage } from './utils.js';

type AttemptResult = 'success' | 'error';

function isRetryableCodexSessionFailureAttempt(args: {
  provider: 'claude' | 'codex';
  attempt: MessageAgentAttempt;
}): boolean {
  const { provider, attempt } = args;
  if (provider !== 'codex' || attempt.sawOutput) return false;
  if (attempt.retryableSessionFailureDetected === true) return true;
  if (attempt.output != null)
    return shouldRetryFreshCodexSessionOnAgentFailure(attempt.output);
  return attempt.error == null
    ? false
    : shouldRetryFreshCodexSessionOnAgentFailure({
        result: null,
        error: getErrorMessage(attempt.error),
      });
}

interface ExecuteMessageAgentAttemptLifecycleArgs {
  provider: 'claude' | 'codex';
  runAttempt: (provider: 'claude' | 'codex') => Promise<MessageAgentAttempt>;
  isClaudeCodeAgent: boolean;
  canRetryClaudeCredentials: boolean;
  clearStoredSession: () => void;
  clearRoleSdkSessions: () => void;
  sessionFolder: string;
  maybeHandoffToCodex: (
    reason: AgentTriggerReason,
    sawVisibleOutput: boolean,
  ) => boolean;
  hasDirectTerminalDelivery: () => boolean;
  pairedExecutionLifecycle: Pick<
    PairedExecutionLifecycle,
    'markStatus' | 'markSawOutput' | 'updateSummary' | 'getSummary'
  >;
  shouldRetryFreshSessionOnAgentFailure: (args: {
    result: null;
    error: string;
  }) => boolean;
  rotationLogContext: {
    chatJid: string;
    group: string;
    groupFolder: string;
    runId: string;
  };
  log: {
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
    error: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
}

interface RecoveryResult {
  attempt: MessageAgentAttempt;
  resolved: AttemptResult | null;
}

class MessageAgentAttemptLifecycleRunner {
  private resetSessionRequested = false;

  constructor(private readonly args: ExecuteMessageAgentAttemptLifecycleArgs) {}

  async execute(): Promise<AttemptResult> {
    let primaryAttempt = await this.runTrackedAttempt(this.args.provider);
    const recoveredSessionAttempt =
      await this.recoverRetryableClaudeSessionFailure(primaryAttempt);
    if (recoveredSessionAttempt.resolved) {
      return recoveredSessionAttempt.resolved;
    }
    primaryAttempt = recoveredSessionAttempt.attempt;

    const recoveredCodexSessionAttempt =
      await this.recoverRetryableCodexSessionFailure(primaryAttempt);
    if (recoveredCodexSessionAttempt.resolved) {
      return recoveredCodexSessionAttempt.resolved;
    }
    primaryAttempt = recoveredCodexSessionAttempt.attempt;

    if (primaryAttempt.error) {
      return this.handlePrimaryAttemptFailure(
        primaryAttempt,
        getErrorMessage(primaryAttempt.error),
      );
    }

    return this.finalizePrimaryAttempt(primaryAttempt);
  }

  private rememberAttempt(attempt: MessageAgentAttempt): MessageAgentAttempt {
    if (attempt.resetSessionRequested) {
      this.resetSessionRequested = true;
    }
    return attempt;
  }

  private async runTrackedAttempt(
    currentProvider: 'claude' | 'codex',
  ): Promise<MessageAgentAttempt> {
    return this.rememberAttempt(await this.args.runAttempt(currentProvider));
  }

  private async retryCodexWithRotation(
    initialTrigger: { reason: CodexRotationReason },
    rotationMessage?: string,
  ): Promise<AttemptResult> {
    return runCodexAttemptWithRotation({
      initialTrigger,
      runAttempt: () => this.runTrackedAttempt('codex'),
      logContext: this.args.rotationLogContext,
      rotationMessage,
    });
  }

  private async retryClaudeWithRotation(
    initialTrigger: {
      reason: AgentTriggerReason;
      retryAfterMs?: number;
    },
    rotationMessage?: string,
  ): Promise<AttemptResult> {
    return runClaudeAttemptWithRotation({
      initialTrigger,
      runAttempt: () => this.runTrackedAttempt('claude'),
      logContext: this.args.rotationLogContext,
      rotationMessage,
      onSuccess: ({ sawOutput }) => {
        this.args.pairedExecutionLifecycle.markSawOutput(sawOutput);
      },
    });
  }

  private maybeHandoffAfterError(
    reason: AgentTriggerReason,
    attempt: MessageAgentAttempt,
  ): AttemptResult {
    if (this.args.maybeHandoffToCodex(reason, attempt.sawVisibleOutput)) {
      return 'success';
    }
    return 'error';
  }

  private async retryClaudeAttemptIfNeeded(
    attempt: MessageAgentAttempt,
    rotationMessage?: string | null,
  ): Promise<AttemptResult | null> {
    const retryAction = await executeAttemptRetryAction({
      provider: this.args.provider,
      canRetryClaudeCredentials: this.args.canRetryClaudeCredentials,
      canRetryCodex: false,
      attempt,
      rotationMessage,
      runClaude: (trigger, message) =>
        this.retryClaudeWithRotation(trigger, message),
      runCodex: (trigger, message) =>
        this.retryCodexWithRotation(trigger, message),
    });
    if (retryAction.kind !== 'claude') {
      return null;
    }

    if (retryAction.result === 'error') {
      return this.maybeHandoffAfterError(retryAction.trigger.reason, attempt);
    }

    this.args.pairedExecutionLifecycle.markStatus('succeeded');
    return retryAction.result;
  }

  private async retryCodexAttemptIfNeeded(
    attempt: MessageAgentAttempt,
    rotationMessage?: string | null,
  ): Promise<AttemptResult | null> {
    const retryAction = await executeAttemptRetryAction({
      provider: this.args.provider,
      canRetryClaudeCredentials: false,
      canRetryCodex: !this.args.isClaudeCodeAgent && getCodexAccountCount() > 1,
      attempt,
      rotationMessage,
      runClaude: (trigger, message) =>
        this.retryClaudeWithRotation(trigger, message),
      runCodex: (trigger, message) =>
        this.retryCodexWithRotation(trigger, message),
    });
    if (retryAction.kind !== 'codex') {
      return null;
    }

    if (retryAction.result === 'success') {
      this.args.pairedExecutionLifecycle.markStatus('succeeded');
    }
    return retryAction.result;
  }

  private isRetryableClaudeSessionFailure(
    attempt: MessageAgentAttempt,
  ): boolean {
    return isRetryableClaudeSessionFailureAttempt({
      attempt,
      isClaudeCodeAgent: this.args.isClaudeCodeAgent,
      provider: this.args.provider,
      shouldRetryFreshSessionOnAgentFailure:
        this.args.shouldRetryFreshSessionOnAgentFailure,
    });
  }

  private async recoverRetryableClaudeSessionFailure(
    attempt: MessageAgentAttempt,
  ): Promise<RecoveryResult> {
    const { clearRoleSdkSessions, clearStoredSession, log } = this.args;
    if (!this.isRetryableClaudeSessionFailure(attempt)) {
      return { attempt, resolved: null };
    }

    clearStoredSession();
    clearRoleSdkSessions();
    log.warn(
      'Cleared poisoned Claude session before visible output, retrying fresh session',
    );

    const freshAttempt = await this.runTrackedAttempt('claude');
    if (!this.isRetryableClaudeSessionFailure(freshAttempt)) {
      return { attempt: freshAttempt, resolved: null };
    }

    clearStoredSession();
    log.warn('Fresh Claude retry also hit a retryable session failure');
    log.error('Retryable Claude session failure persisted after fresh retry');
    return {
      attempt: freshAttempt,
      resolved: this.maybeHandoffAfterError('session-failure', freshAttempt),
    };
  }

  private async recoverRetryableCodexSessionFailure(
    attempt: MessageAgentAttempt,
  ): Promise<RecoveryResult> {
    const { clearRoleSdkSessions, clearStoredSession, log, provider } =
      this.args;
    if (!isRetryableCodexSessionFailureAttempt({ provider, attempt })) {
      return { attempt, resolved: null };
    }

    clearStoredSession();
    clearRoleSdkSessions();
    log.warn(
      'Cleared poisoned Codex session before visible output, retrying fresh session',
    );

    const freshAttempt = await this.runTrackedAttempt('codex');
    if (
      !isRetryableCodexSessionFailureAttempt({
        provider,
        attempt: freshAttempt,
      })
    ) {
      return { attempt: freshAttempt, resolved: null };
    }

    clearStoredSession();
    log.warn('Fresh Codex retry also hit a retryable session failure');
    log.error('Retryable Codex session failure persisted after fresh retry');
    return {
      attempt: freshAttempt,
      resolved: 'error',
    };
  }

  private async handlePrimaryAttemptFailure(
    attempt: MessageAgentAttempt,
    rotationMessage: string,
  ): Promise<AttemptResult> {
    const { log, provider } = this.args;
    const claudeRetryResult = await this.retryClaudeAttemptIfNeeded(
      attempt,
      rotationMessage,
    );
    if (claudeRetryResult) {
      return claudeRetryResult;
    }

    const codexRetryResult = await this.retryCodexAttemptIfNeeded(
      attempt,
      rotationMessage,
    );
    if (codexRetryResult) {
      return codexRetryResult;
    }

    if (attempt.error) {
      log.error(
        {
          provider,
          err: attempt.error,
        },
        'Agent error',
      );
      return 'error';
    }

    log.error(
      {
        provider,
        error: attempt.output?.error,
      },
      'Agent process error',
    );
    return 'error';
  }

  private async finalizePrimaryAttempt(
    attempt: MessageAgentAttempt,
  ): Promise<AttemptResult> {
    const { log, provider } = this.args;
    const output = attempt.output;
    if (!output) {
      log.error({ provider }, 'Agent produced no output object');
      return 'error';
    }

    this.updateSummaryFromOutputIfNeeded(output);

    if (
      !attempt.sawOutput &&
      !this.args.hasDirectTerminalDelivery() &&
      output.status !== 'error'
    ) {
      const claudeRetryResult = await this.retryClaudeAttemptIfNeeded(attempt);
      if (claudeRetryResult) {
        return claudeRetryResult;
      }
    }

    this.clearPoisonedSessionAfterFailure(output);

    if (output.status === 'error') {
      return this.handlePrimaryAttemptFailure(
        attempt,
        output.error ?? 'Agent process error',
      );
    }

    const codexRetryResult = await this.retryCodexAttemptIfNeeded(
      attempt,
      output.error ?? output.result,
    );
    if (codexRetryResult) {
      return codexRetryResult;
    }

    if (attempt.streamedTriggerReason) {
      if (this.resolveStreamedTriggerHandoff(attempt)) {
        return 'success';
      }
      log.error(
        {
          reason: attempt.streamedTriggerReason.reason,
        },
        'Agent trigger detected but could not be resolved',
      );
      return 'error';
    }

    if (this.isSuccessWithoutVisibleOutput(attempt)) {
      log.error(
        'Agent returned success with null result and no visible output',
      );
      return 'error';
    }

    this.args.pairedExecutionLifecycle.markStatus('succeeded');
    this.args.pairedExecutionLifecycle.markSawOutput(
      attempt.sawOutput || this.args.hasDirectTerminalDelivery(),
    );
    return 'success';
  }

  private updateSummaryFromOutputIfNeeded(
    output: NonNullable<MessageAgentAttempt['output']>,
  ): void {
    const { pairedExecutionLifecycle } = this.args;
    if (pairedExecutionLifecycle.getSummary()) {
      return;
    }
    const finalOutputText = getAgentOutputText(output);
    pairedExecutionLifecycle.updateSummary({
      outputText:
        typeof finalOutputText === 'string' && finalOutputText.length > 0
          ? finalOutputText
          : null,
      errorText:
        typeof output.error === 'string' && output.error.length > 0
          ? output.error
          : null,
    });
  }

  private clearPoisonedSessionAfterFailure(
    output: NonNullable<MessageAgentAttempt['output']>,
  ): void {
    const {
      clearRoleSdkSessions,
      clearStoredSession,
      isClaudeCodeAgent,
      log,
      provider,
      sessionFolder,
    } = this.args;
    if (
      isClaudeCodeAgent &&
      (this.resetSessionRequested || shouldResetSessionOnAgentFailure(output))
    ) {
      clearStoredSession();
      log.warn(
        { sessionFolder },
        'Cleared poisoned agent session after unrecoverable error',
      );
      return;
    }
    if (
      !isClaudeCodeAgent &&
      provider === 'codex' &&
      (this.resetSessionRequested ||
        shouldResetCodexSessionOnAgentFailure(output))
    ) {
      clearStoredSession();
      clearRoleSdkSessions();
      log.warn(
        { sessionFolder },
        'Cleared poisoned Codex session after unrecoverable error',
      );
    }
  }

  private resolveStreamedTriggerHandoff(attempt: MessageAgentAttempt): boolean {
    if (!attempt.streamedTriggerReason || !this.args.isClaudeCodeAgent) {
      return false;
    }
    return this.args.maybeHandoffToCodex(
      attempt.streamedTriggerReason.reason,
      attempt.sawVisibleOutput,
    );
  }

  private isSuccessWithoutVisibleOutput(attempt: MessageAgentAttempt): boolean {
    return (
      attempt.sawSuccessNullResultWithoutOutput &&
      !attempt.sawOutput &&
      !this.args.hasDirectTerminalDelivery()
    );
  }
}

export async function executeMessageAgentAttemptLifecycle(
  args: ExecuteMessageAgentAttemptLifecycleArgs,
): Promise<AttemptResult> {
  return new MessageAgentAttemptLifecycleRunner(args).execute();
}
