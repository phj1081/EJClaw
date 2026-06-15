import { getAgentOutputText, hasAgentOutputPayload } from './agent-output.js';
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
  message?: string;
}

export interface StreamedOutputState {
  sawOutput: boolean;
  sawVisibleOutput: boolean;
  sawSuccessNullResultWithoutOutput: boolean;
  streamedTriggerReason?: StreamedTriggerReason;
  retryableSessionFailureDetected?: boolean;
}

export interface EvaluateStreamedOutputOptions {
  agentType: 'claude-code' | 'codex' | 'glm-code';
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
  const primaryAgent = primaryAgentFor(options);
  const countsAsFinalOutput =
    output.phase === undefined || output.phase === 'final';
  const outputText = getAgentOutputText(output);

  const retryableSessionFailure = suppressRetryableSessionFailure(
    output,
    state,
    nextState,
    primaryAgent,
  );
  if (retryableSessionFailure) return retryableSessionFailure;

  if (
    primaryAgent === 'claude' &&
    output.status === 'success' &&
    !state.sawOutput &&
    typeof outputText === 'string'
  ) {
    const triggerReason = classifyClaudeSuccessTrigger(outputText);
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
    primaryAgent === 'claude' &&
    output.status === 'success' &&
    !state.sawOutput
  ) {
    nextState.sawSuccessNullResultWithoutOutput = true;
  }

  if (
    primaryAgent === 'codex' &&
    typeof output.error === 'string' &&
    output.error.length > 0 &&
    !nextState.sawOutput &&
    !nextState.streamedTriggerReason
  ) {
    const trigger = detectCodexRotationTrigger(output.error);
    if (trigger.shouldRotate) {
      const newTrigger: StreamedTriggerReason = {
        reason: trigger.reason,
        message: output.error,
      };
      nextState.streamedTriggerReason = newTrigger;
      return {
        state: nextState,
        shouldForwardOutput: !options.shortCircuitTriggeredErrors,
        newTrigger,
      };
    }
  }

  if (
    output.status === 'error' &&
    !nextState.sawOutput &&
    !nextState.streamedTriggerReason
  ) {
    let newTrigger: StreamedTriggerReason | undefined;

    if (primaryAgent === 'claude') {
      const trigger = classifyRotationTrigger(output.error);
      if (trigger.shouldRetry) {
        newTrigger = {
          reason: trigger.reason,
          retryAfterMs: trigger.retryAfterMs,
        };
      }
    } else if (primaryAgent === 'codex') {
      const trigger = detectCodexRotationTrigger(output.error);
      if (trigger.shouldRotate) {
        newTrigger = { reason: trigger.reason, message: output.error };
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

type PrimaryAgent = 'claude' | 'codex' | undefined;

function primaryAgentFor(options: EvaluateStreamedOutputOptions): PrimaryAgent {
  if (
    (options.agentType === 'claude-code' || options.agentType === 'glm-code') &&
    options.provider === 'claude'
  ) {
    return 'claude';
  }
  if (options.agentType === 'codex' && options.provider === 'codex') {
    return 'codex';
  }
  return undefined;
}

function suppressRetryableSessionFailure(
  output: AgentOutput,
  state: StreamedOutputState,
  nextState: StreamedOutputState,
  primaryAgent: PrimaryAgent,
): EvaluateStreamedOutputResult | undefined {
  if (state.sawOutput) return undefined;

  const shouldSuppress =
    primaryAgent === 'claude'
      ? shouldRetryFreshSessionOnAgentFailure(output)
      : primaryAgent === 'codex'
        ? shouldRetryFreshCodexSessionOnAgentFailure(output)
        : false;
  if (!shouldSuppress) return undefined;

  nextState.retryableSessionFailureDetected = true;
  return {
    state: nextState,
    shouldForwardOutput: false,
    suppressedRetryableSessionFailure: true,
  };
}

function classifyClaudeSuccessTrigger(
  outputText: string,
): AgentTriggerReason | undefined {
  if (isClaudeUsageExhaustedMessage(outputText)) return 'usage-exhausted';

  const authClassification = classifyClaudeAuthError(outputText);
  if (
    isClaudeOrgAccessDeniedMessage(outputText) ||
    authClassification.category === 'org-access-denied'
  ) {
    return 'org-access-denied';
  }
  if (
    isClaudeAuthExpiredMessage(outputText) ||
    authClassification.category === 'auth-expired'
  ) {
    return 'auth-expired';
  }
  return detectClaudeProviderFailureMessage(outputText) || undefined;
}
