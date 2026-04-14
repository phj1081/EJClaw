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

export async function executeMessageAgentAttemptLifecycle(args: {
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
}): Promise<AttemptResult> {
  const {
    provider,
    runAttempt,
    isClaudeCodeAgent,
    canRetryClaudeCredentials,
    clearStoredSession,
    clearRoleSdkSessions,
    sessionFolder,
    maybeHandoffToCodex,
    hasDirectTerminalDelivery,
    pairedExecutionLifecycle,
    shouldRetryFreshSessionOnAgentFailure,
    rotationLogContext,
    log,
  } = args;

  let resetSessionRequested = false;
  const rememberAttempt = (
    attempt: MessageAgentAttempt,
  ): MessageAgentAttempt => {
    if (attempt.resetSessionRequested) {
      resetSessionRequested = true;
    }
    return attempt;
  };

  const runTrackedAttempt = async (
    currentProvider: 'claude' | 'codex',
  ): Promise<MessageAgentAttempt> =>
    rememberAttempt(await runAttempt(currentProvider));

  const retryCodexWithRotation = async (
    initialTrigger: { reason: CodexRotationReason },
    rotationMessage?: string,
  ): Promise<AttemptResult> => {
    return runCodexAttemptWithRotation({
      initialTrigger,
      runAttempt: () => runTrackedAttempt('codex'),
      logContext: rotationLogContext,
      rotationMessage,
    });
  };

  const retryClaudeWithRotation = async (
    initialTrigger: {
      reason: AgentTriggerReason;
      retryAfterMs?: number;
    },
    rotationMessage?: string,
  ): Promise<AttemptResult> => {
    return runClaudeAttemptWithRotation({
      initialTrigger,
      runAttempt: () => runTrackedAttempt('claude'),
      logContext: rotationLogContext,
      rotationMessage,
      onSuccess: ({ sawOutput }) => {
        pairedExecutionLifecycle.markSawOutput(sawOutput);
      },
    });
  };

  const maybeHandoffAfterError = (
    reason: AgentTriggerReason,
    attempt: MessageAgentAttempt,
  ): AttemptResult => {
    if (maybeHandoffToCodex(reason, attempt.sawVisibleOutput)) {
      return 'success';
    }
    return 'error';
  };

  const retryClaudeAttemptIfNeeded = async (
    attempt: MessageAgentAttempt,
    rotationMessage?: string | null,
  ): Promise<AttemptResult | null> => {
    const retryAction = await executeAttemptRetryAction({
      provider,
      canRetryClaudeCredentials,
      canRetryCodex: false,
      attempt,
      rotationMessage,
      runClaude: retryClaudeWithRotation,
      runCodex: retryCodexWithRotation,
    });
    if (retryAction.kind !== 'claude') {
      return null;
    }

    if (retryAction.result === 'error') {
      return maybeHandoffAfterError(retryAction.trigger.reason, attempt);
    }

    pairedExecutionLifecycle.markStatus('succeeded');
    return retryAction.result;
  };

  const retryCodexAttemptIfNeeded = async (
    attempt: MessageAgentAttempt,
    rotationMessage?: string | null,
  ): Promise<AttemptResult | null> => {
    const retryAction = await executeAttemptRetryAction({
      provider,
      canRetryClaudeCredentials: false,
      canRetryCodex: !isClaudeCodeAgent && getCodexAccountCount() > 1,
      attempt,
      rotationMessage,
      runClaude: retryClaudeWithRotation,
      runCodex: retryCodexWithRotation,
    });
    if (retryAction.kind !== 'codex') {
      return null;
    }

    if (retryAction.result === 'success') {
      pairedExecutionLifecycle.markStatus('succeeded');
    }
    return retryAction.result;
  };

  const isRetryableClaudeSessionFailure = (
    attempt: MessageAgentAttempt,
  ): boolean =>
    isRetryableClaudeSessionFailureAttempt({
      attempt,
      isClaudeCodeAgent,
      provider,
      shouldRetryFreshSessionOnAgentFailure,
    });

  const recoverRetryableClaudeSessionFailure = async (
    attempt: MessageAgentAttempt,
  ): Promise<{
    attempt: MessageAgentAttempt;
    resolved: AttemptResult | null;
  }> => {
    if (!isRetryableClaudeSessionFailure(attempt)) {
      return { attempt, resolved: null };
    }

    clearStoredSession();
    clearRoleSdkSessions();
    log.warn(
      'Cleared poisoned Claude session before visible output, retrying fresh session',
    );

    const freshAttempt = await runTrackedAttempt('claude');
    if (!isRetryableClaudeSessionFailure(freshAttempt)) {
      return { attempt: freshAttempt, resolved: null };
    }

    clearStoredSession();
    log.warn('Fresh Claude retry also hit a retryable session failure');
    log.error('Retryable Claude session failure persisted after fresh retry');
    return {
      attempt: freshAttempt,
      resolved: maybeHandoffAfterError('session-failure', freshAttempt),
    };
  };

  const isRetryableCodexSessionFailure = (
    attempt: MessageAgentAttempt,
  ): boolean => {
    if (provider !== 'codex' || attempt.sawOutput) {
      return false;
    }

    if (attempt.retryableSessionFailureDetected === true) {
      return true;
    }

    if (attempt.error == null) {
      return false;
    }

    return shouldRetryFreshCodexSessionOnAgentFailure({
      result: null,
      error: getErrorMessage(attempt.error),
    });
  };

  const recoverRetryableCodexSessionFailure = async (
    attempt: MessageAgentAttempt,
  ): Promise<{
    attempt: MessageAgentAttempt;
    resolved: AttemptResult | null;
  }> => {
    if (!isRetryableCodexSessionFailure(attempt)) {
      return { attempt, resolved: null };
    }

    clearStoredSession();
    clearRoleSdkSessions();
    log.warn(
      'Cleared poisoned Codex session before visible output, retrying fresh session',
    );

    const freshAttempt = await runTrackedAttempt('codex');
    if (!isRetryableCodexSessionFailure(freshAttempt)) {
      return { attempt: freshAttempt, resolved: null };
    }

    clearStoredSession();
    log.warn('Fresh Codex retry also hit a retryable session failure');
    log.error('Retryable Codex session failure persisted after fresh retry');
    return {
      attempt: freshAttempt,
      resolved: 'error',
    };
  };

  const handlePrimaryAttemptFailure = async (
    attempt: MessageAgentAttempt,
    rotationMessage: string,
  ): Promise<AttemptResult> => {
    const claudeRetryResult = await retryClaudeAttemptIfNeeded(
      attempt,
      rotationMessage,
    );
    if (claudeRetryResult) {
      return claudeRetryResult;
    }

    const codexRetryResult = await retryCodexAttemptIfNeeded(
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
  };

  const finalizePrimaryAttempt = async (
    attempt: MessageAgentAttempt,
  ): Promise<AttemptResult> => {
    const output = attempt.output;
    if (!output) {
      log.error({ provider }, 'Agent produced no output object');
      return 'error';
    }

    if (!pairedExecutionLifecycle.getSummary()) {
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

    if (
      !attempt.sawOutput &&
      !hasDirectTerminalDelivery() &&
      output.status !== 'error'
    ) {
      const claudeRetryResult = await retryClaudeAttemptIfNeeded(attempt);
      if (claudeRetryResult) {
        return claudeRetryResult;
      }
    }

    if (
      isClaudeCodeAgent &&
      (resetSessionRequested || shouldResetSessionOnAgentFailure(output))
    ) {
      clearStoredSession();
      log.warn(
        { sessionFolder },
        'Cleared poisoned agent session after unrecoverable error',
      );
    }

    if (
      !isClaudeCodeAgent &&
      provider === 'codex' &&
      (resetSessionRequested || shouldResetCodexSessionOnAgentFailure(output))
    ) {
      clearStoredSession();
      clearRoleSdkSessions();
      log.warn(
        { sessionFolder },
        'Cleared poisoned Codex session after unrecoverable error',
      );
    }

    if (output.status === 'error') {
      return handlePrimaryAttemptFailure(
        attempt,
        output.error ?? 'Agent process error',
      );
    }

    const codexRetryResult = await retryCodexAttemptIfNeeded(
      attempt,
      output.error ?? output.result,
    );
    if (codexRetryResult) {
      return codexRetryResult;
    }

    if (attempt.streamedTriggerReason) {
      if (
        isClaudeCodeAgent &&
        maybeHandoffToCodex(
          attempt.streamedTriggerReason.reason,
          attempt.sawVisibleOutput,
        )
      ) {
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

    if (
      attempt.sawSuccessNullResultWithoutOutput &&
      !attempt.sawOutput &&
      !hasDirectTerminalDelivery()
    ) {
      log.error(
        'Agent returned success with null result and no visible output',
      );
      return 'error';
    }

    pairedExecutionLifecycle.markStatus('succeeded');
    pairedExecutionLifecycle.markSawOutput(
      attempt.sawOutput || hasDirectTerminalDelivery(),
    );
    return 'success';
  };

  let primaryAttempt = await runTrackedAttempt(provider);
  const recoveredSessionAttempt =
    await recoverRetryableClaudeSessionFailure(primaryAttempt);
  if (recoveredSessionAttempt.resolved) {
    return recoveredSessionAttempt.resolved;
  }
  primaryAttempt = recoveredSessionAttempt.attempt;

  const recoveredCodexSessionAttempt =
    await recoverRetryableCodexSessionFailure(primaryAttempt);
  if (recoveredCodexSessionAttempt.resolved) {
    return recoveredCodexSessionAttempt.resolved;
  }
  primaryAttempt = recoveredCodexSessionAttempt.attempt;

  if (primaryAttempt.error) {
    return handlePrimaryAttemptFailure(
      primaryAttempt,
      getErrorMessage(primaryAttempt.error),
    );
  }

  return finalizePrimaryAttempt(primaryAttempt);
}
