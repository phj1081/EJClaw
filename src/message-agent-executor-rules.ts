import {
  classifyRotationTrigger,
  type AgentTriggerReason,
  type CodexRotationReason,
  isCodexRotationReason,
} from './agent-error-detection.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';
import type { PairedRoomRole, PairedTaskStatus } from './types.js';
import { getErrorMessage } from './utils.js';

export interface ExecutorStreamedTrigger {
  reason: AgentTriggerReason;
  retryAfterMs?: number;
}

export interface ExecutorAttemptState {
  sawOutput: boolean;
  retryableSessionFailureDetected?: boolean;
  streamedTriggerReason?: ExecutorStreamedTrigger;
  error?: unknown;
}

export function isRetryableClaudeSessionFailureAttempt(args: {
  attempt: ExecutorAttemptState;
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
  attempt: Pick<ExecutorAttemptState, 'sawOutput' | 'streamedTriggerReason'>;
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
  attempt: Pick<ExecutorAttemptState, 'streamedTriggerReason'>;
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

export type PairedFollowUpQueueAction =
  | 'generic'
  | 'pending'
  | 'skip-inline-finalize'
  | 'none';

export function resolvePairedFollowUpQueueAction(args: {
  completedRole: PairedRoomRole;
  executionStatus: 'succeeded' | 'failed';
  sawOutput: boolean;
  taskStatus: PairedTaskStatus | null;
}): PairedFollowUpQueueAction {
  if (args.executionStatus === 'succeeded' && args.sawOutput) {
    if (
      args.completedRole === 'owner' &&
      args.taskStatus === 'review_ready'
    ) {
      return 'generic';
    }

    return args.completedRole === 'reviewer' &&
      args.taskStatus === 'merge_ready'
      ? 'skip-inline-finalize'
      : 'none';
  }

  const shouldRequeuePendingPairedTurn =
    (args.completedRole === 'reviewer' || args.completedRole === 'arbiter') &&
    (args.taskStatus === 'review_ready' ||
      args.taskStatus === 'in_review' ||
      args.taskStatus === 'arbiter_requested' ||
      args.taskStatus === 'in_arbitration' ||
      args.taskStatus === 'merge_ready');
  return shouldRequeuePendingPairedTurn ? 'pending' : 'none';
}
