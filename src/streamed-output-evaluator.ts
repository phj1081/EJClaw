import {
  classifyClaudeAuthError,
  classifyRotationTrigger,
  detectClaudeProviderFailureMessage,
  isClaudeAuthError,
  isClaudeAuthExpiredMessage,
  isClaudeOrgAccessDeniedMessage,
  isClaudeUsageExhaustedMessage,
  type AgentTriggerReason,
} from './agent-error-detection.js';
import type { AgentOutput } from './agent-runner.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';
import { shouldRetryFreshSessionOnAgentFailure } from './session-recovery.js';

export interface StreamedTriggerReason {
  reason: AgentTriggerReason;
  retryAfterMs?: number;
}

export interface StreamedOutputState {
  sawOutput: boolean;
  sawVisibleOutput: boolean;
  sawSuccessNullResultWithoutOutput: boolean;
  streamedTriggerReason?: StreamedTriggerReason;
  retryableSessionFailureDetected?: boolean;
}

export interface EvaluateStreamedOutputOptions {
  agentType: 'claude-code' | 'codex';
  provider: string;
  suppressClaudeAuthErrorOutput?: boolean;
  trackSuccessNullResult?: boolean;
  shortCircuitTriggeredErrors?: boolean;
}

export interface EvaluateStreamedOutputResult {
  state: StreamedOutputState;
  shouldForwardOutput: boolean;
  newTrigger?: StreamedTriggerReason;
  suppressedAuthError?: boolean;
  suppressedRetryableSessionFailure?: boolean;
}

export function evaluateStreamedOutput(
  output: AgentOutput,
  state: StreamedOutputState,
  options: EvaluateStreamedOutputOptions,
): EvaluateStreamedOutputResult {
  const nextState: StreamedOutputState = { ...state };
  const isPrimaryClaude =
    options.agentType === 'claude-code' && options.provider === 'claude';
  const isPrimaryCodex =
    options.agentType === 'codex' && options.provider === 'codex';
  const countsAsFinalOutput =
    output.phase === undefined || output.phase === 'final';

  if (
    isPrimaryClaude &&
    !state.sawOutput &&
    shouldRetryFreshSessionOnAgentFailure(output)
  ) {
    nextState.retryableSessionFailureDetected = true;
    return {
      state: nextState,
      shouldForwardOutput: false,
      suppressedRetryableSessionFailure: true,
    };
  }

  if (
    isPrimaryClaude &&
    output.status === 'success' &&
    !state.sawOutput &&
    typeof output.result === 'string'
  ) {
    const authClassification = classifyClaudeAuthError(output.result);
    const triggerReason: AgentTriggerReason | undefined =
      isClaudeUsageExhaustedMessage(output.result)
        ? 'usage-exhausted'
        : isClaudeOrgAccessDeniedMessage(output.result) ||
            authClassification.category === 'org-access-denied'
          ? 'org-access-denied'
          : isClaudeAuthExpiredMessage(output.result) ||
              authClassification.category === 'auth-expired'
            ? 'auth-expired'
            : detectClaudeProviderFailureMessage(output.result) || undefined;

    if (triggerReason) {
      const newTrigger = nextState.streamedTriggerReason
        ? undefined
        : { reason: triggerReason };
      nextState.streamedTriggerReason =
        nextState.streamedTriggerReason ?? newTrigger;
      return {
        state: nextState,
        shouldForwardOutput: false,
        newTrigger,
      };
    }

    if (
      options.suppressClaudeAuthErrorOutput &&
      isClaudeAuthError(output.result)
    ) {
      return {
        state: nextState,
        shouldForwardOutput: false,
        suppressedAuthError: true,
      };
    }
  }

  if (
    countsAsFinalOutput &&
    output.result !== null &&
    output.result !== undefined
  ) {
    nextState.sawOutput = true;
  } else if (
    options.trackSuccessNullResult &&
    isPrimaryClaude &&
    output.status === 'success' &&
    !state.sawOutput
  ) {
    nextState.sawSuccessNullResultWithoutOutput = true;
  }

  if (
    output.status === 'error' &&
    !nextState.sawOutput &&
    !nextState.streamedTriggerReason
  ) {
    let newTrigger: StreamedTriggerReason | undefined;

    if (isPrimaryClaude) {
      const trigger = classifyRotationTrigger(output.error);
      if (trigger.shouldRetry) {
        newTrigger = {
          reason: trigger.reason,
          retryAfterMs: trigger.retryAfterMs,
        };
      }
    } else if (isPrimaryCodex) {
      const trigger = detectCodexRotationTrigger(output.error);
      if (trigger.shouldRotate) {
        newTrigger = { reason: trigger.reason };
      }
    }

    if (newTrigger) {
      nextState.streamedTriggerReason = newTrigger;
      return {
        state: nextState,
        shouldForwardOutput: !options.shortCircuitTriggeredErrors,
        newTrigger,
      };
    }
  }

  return {
    state: nextState,
    shouldForwardOutput: true,
  };
}
