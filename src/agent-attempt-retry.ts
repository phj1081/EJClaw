import {
  classifyRotationTrigger,
  type AgentTriggerReason,
  type CodexRotationReason,
  isCodexRotationReason,
} from './agent-error-detection.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';
import { getErrorMessage } from './utils.js';

export interface AttemptStreamedTrigger {
  reason: AgentTriggerReason;
  retryAfterMs?: number;
}

export interface AttemptRetryState {
  sawOutput: boolean;
  retryableSessionFailureDetected?: boolean;
  streamedTriggerReason?: AttemptStreamedTrigger;
  error?: unknown;
  outputError?: string | null;
}

export function isRetryableClaudeSessionFailureAttempt(args: {
  attempt: AttemptRetryState;
  isClaudeCodeAgent: boolean;
  provider: 'claude' | 'codex';
  shouldRetryFreshSessionOnAgentFailure: (args: {
    result: null;
    error: string;
  }) => boolean;
}): boolean {
  if (
    !args.isClaudeCodeAgent ||
    args.provider !== 'claude' ||
    args.attempt.sawOutput
  ) {
    return false;
  }

  if (args.attempt.retryableSessionFailureDetected === true) {
    return true;
  }

  if (args.attempt.error == null) {
    return false;
  }

  return args.shouldRetryFreshSessionOnAgentFailure({
    result: null,
    error: getErrorMessage(args.attempt.error),
  });
}

export function resolveClaudeRetryTrigger(args: {
  canRetryClaudeCredentials: boolean;
  provider: 'claude' | 'codex';
  attempt: Pick<AttemptRetryState, 'sawOutput' | 'streamedTriggerReason'>;
  fallbackMessage?: string | null;
}): { reason: AgentTriggerReason; retryAfterMs?: number } | null {
  if (
    !(
      args.canRetryClaudeCredentials &&
      args.provider === 'claude' &&
      !args.attempt.sawOutput
    )
  ) {
    return null;
  }

  if (args.attempt.streamedTriggerReason) {
    return {
      reason: args.attempt.streamedTriggerReason.reason,
      retryAfterMs: args.attempt.streamedTriggerReason.retryAfterMs,
    };
  }

  const trigger = classifyRotationTrigger(args.fallbackMessage);
  if (!trigger.shouldRetry) {
    return null;
  }

  return {
    reason: trigger.reason,
    retryAfterMs: trigger.retryAfterMs,
  };
}

export function resolveCodexRetryTrigger(args: {
  canRetryCodex: boolean;
  attempt: Pick<AttemptRetryState, 'streamedTriggerReason'>;
  rotationMessage?: string | null;
}): { reason: CodexRotationReason } | null {
  if (!args.canRetryCodex) {
    return null;
  }

  if (args.attempt.streamedTriggerReason) {
    if (!isCodexRotationReason(args.attempt.streamedTriggerReason.reason)) {
      return null;
    }
    return {
      reason: args.attempt.streamedTriggerReason.reason,
    };
  }

  const trigger = detectCodexRotationTrigger(args.rotationMessage);
  if (!trigger.shouldRotate) {
    return null;
  }

  return { reason: trigger.reason };
}

export type AttemptRetryAction =
  | {
      kind: 'claude';
      trigger: { reason: AgentTriggerReason; retryAfterMs?: number };
      rotationMessage?: string;
    }
  | {
      kind: 'codex';
      trigger: { reason: CodexRotationReason };
      rotationMessage?: string;
    }
  | { kind: 'none' };

export function resolveAttemptRetryAction(args: {
  provider: 'claude' | 'codex';
  canRetryClaudeCredentials: boolean;
  canRetryCodex: boolean;
  attempt: Pick<AttemptRetryState, 'sawOutput' | 'streamedTriggerReason'>;
  rotationMessage?: string | null;
}): AttemptRetryAction {
  const normalizedRotationMessage = args.rotationMessage ?? undefined;

  const claudeTrigger = resolveClaudeRetryTrigger({
    canRetryClaudeCredentials: args.canRetryClaudeCredentials,
    provider: args.provider,
    attempt: args.attempt,
    fallbackMessage: normalizedRotationMessage,
  });
  if (claudeTrigger) {
    return {
      kind: 'claude',
      trigger: claudeTrigger,
      rotationMessage: normalizedRotationMessage,
    };
  }

  const codexTrigger = resolveCodexRetryTrigger({
    canRetryCodex: args.canRetryCodex,
    attempt: args.attempt,
    rotationMessage: normalizedRotationMessage,
  });
  if (codexTrigger) {
    return {
      kind: 'codex',
      trigger: codexTrigger,
      rotationMessage: normalizedRotationMessage,
    };
  }

  return { kind: 'none' };
}
