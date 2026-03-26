import {
  detectClaudeProviderFailureMessage,
  isClaudeAuthError,
  isClaudeAuthExpiredMessage,
  isClaudeOrgAccessDeniedMessage,
  isClaudeUsageExhaustedMessage,
  type AgentTriggerReason,
} from './agent-error-detection.js';
import type { AgentOutput } from './agent-runner.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';
import { detectFallbackTrigger } from './provider-fallback.js';

export interface StreamedTriggerReason {
  reason: AgentTriggerReason;
  retryAfterMs?: number;
}

export interface StreamedOutputState {
  sawOutput: boolean;
  sawSuccessNullResultWithoutOutput: boolean;
  streamedTriggerReason?: StreamedTriggerReason;
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

  if (
    isPrimaryClaude &&
    output.status === 'success' &&
    !state.sawOutput &&
    typeof output.result === 'string'
  ) {
    const triggerReason: AgentTriggerReason | undefined =
      isClaudeUsageExhaustedMessage(output.result)
        ? 'usage-exhausted'
        : isClaudeOrgAccessDeniedMessage(output.result)
          ? 'org-access-denied'
          : isClaudeAuthExpiredMessage(output.result)
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

  if (output.result !== null && output.result !== undefined) {
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
      const trigger = detectFallbackTrigger(output.error);
      if (trigger.shouldFallback) {
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
