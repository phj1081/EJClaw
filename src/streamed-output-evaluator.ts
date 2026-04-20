import {
  getAgentOutputText,
  hasAgentOutputPayload,
  isSilentAgentOutput,
} from './agent-output.js';
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
import {
  shouldRetryFreshCodexSessionOnAgentFailure,
  shouldRetryFreshSessionOnAgentFailure,
} from './session-recovery.js';

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
  const outputText = getAgentOutputText(output);
  const silentOutput = isSilentAgentOutput(output);

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
    isPrimaryCodex &&
    !state.sawOutput &&
    shouldRetryFreshCodexSessionOnAgentFailure(output)
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
    typeof outputText === 'string'
  ) {
    const authClassification = classifyClaudeAuthError(outputText);
    const triggerReason: AgentTriggerReason | undefined =
      isClaudeUsageExhaustedMessage(outputText)
        ? 'usage-exhausted'
        : isClaudeOrgAccessDeniedMessage(outputText) ||
            authClassification.category === 'org-access-denied'
          ? 'org-access-denied'
          : isClaudeAuthExpiredMessage(outputText) ||
              authClassification.category === 'auth-expired'
            ? 'auth-expired'
            : detectClaudeProviderFailureMessage(outputText) || undefined;

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
      isClaudeAuthError(outputText)
    ) {
      return {
        state: nextState,
        shouldForwardOutput: false,
        suppressedAuthError: true,
      };
    }
  }

  if (countsAsFinalOutput && hasAgentOutputPayload(output)) {
    nextState.sawOutput = true;
  } else if (
    options.trackSuccessNullResult &&
    isPrimaryClaude &&
    output.status === 'success' &&
    !state.sawOutput &&
    !silentOutput
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
