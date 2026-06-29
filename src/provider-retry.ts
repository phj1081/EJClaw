/**
 * Shared Claude retry-with-rotation loop (SSOT).
 *
 * Extracted from message-agent-executor.ts and task-scheduler.ts
 * to eliminate the ~255-line structural duplication.
 */

import type { AgentOutput } from './agent-runner.js';
import { getAgentOutputText } from './agent-output.js';
import {
  classifyRotationTrigger,
  type CodexRotationReason,
  isCodexRotationReason,
  shouldRotateClaudeToken,
  type AgentTriggerReason,
} from './agent-error-detection.js';
import {
  detectCodexRotationTrigger,
  getCodexAccountCount,
  markCodexTokenHealthy,
  rotateCodexToken,
} from './codex-token-rotation.js';
import { logger } from './logger.js';
import { getErrorMessage } from './utils.js';
import {
  getCurrentTokenIndex,
  rotateToken,
  getTokenCount,
  markTokenHealthy,
} from './token-rotation.js';
import { forceRefreshToken } from './token-refresh.js';
import { clearGlobalFailover } from './service-routing.js';

// ── Types ────────────────────────────────────────────────────────

export interface TriggerInfo {
  reason: AgentTriggerReason;
  retryAfterMs?: number;
  message?: string;
}

export interface RotationAttemptResult {
  output?: Pick<AgentOutput, 'status' | 'result' | 'output' | 'error'>;
  thrownError?: unknown;
  sawOutput: boolean;
  sawSuccessNullResult?: boolean;
  streamedTriggerReason?: TriggerInfo;
}

export type RotationOutcome =
  | { type: 'success'; sawOutput: boolean }
  | { type: 'error'; trigger?: TriggerInfo };

export interface CodexRotationAttemptResult {
  output?: Pick<AgentOutput, 'status' | 'result' | 'output' | 'error'>;
  thrownError?: unknown;
  sawOutput: boolean;
  streamedTriggerReason?: TriggerInfo;
}

export type CodexRotationOutcome = { type: 'success' } | { type: 'error' };

type AttemptOutcome =
  | { type: 'success'; sawOutput: boolean }
  | { type: 'error'; trigger?: TriggerInfo }
  | {
      type: 'continue';
      trigger: TriggerInfo;
      rotationMessage?: string;
    };

type CodexAttemptOutcome =
  | { type: 'success' }
  | { type: 'error' }
  | {
      type: 'continue';
      trigger: { reason: CodexRotationReason };
      rotationMessage?: string;
    };

const CLAUDE_TRANSIENT_SAME_ACCOUNT_RETRY_REASONS = new Set<AgentTriggerReason>(
  ['overloaded', 'network-error'],
);
const MAX_CLAUDE_TRANSIENT_SAME_ACCOUNT_RETRIES = 2;

export interface ClaudeTransientRetryContext {
  trigger: TriggerInfo;
  attempt: number;
  maxAttempts: number;
}

export interface ClaudeRotationLoopOptions {
  beforeTransientSameAccountRetry?: (
    context: ClaudeTransientRetryContext,
  ) => Promise<void> | void;
}

function shouldRetryClaudeSameAccount(reason: AgentTriggerReason): boolean {
  return CLAUDE_TRANSIENT_SAME_ACCOUNT_RETRY_REASONS.has(reason);
}

function evaluateClaudeAttempt(
  attempt: RotationAttemptResult,
  logContext: Record<string, unknown>,
): AttemptOutcome {
  if (attempt.thrownError) {
    if (!attempt.sawOutput) {
      const errMsg = getErrorMessage(attempt.thrownError);
      const retryTrigger = attempt.streamedTriggerReason
        ? {
            shouldRetry: true,
            reason: attempt.streamedTriggerReason.reason,
            retryAfterMs: attempt.streamedTriggerReason.retryAfterMs,
          }
        : classifyRotationTrigger(errMsg);
      if (retryTrigger.shouldRetry) {
        return {
          type: 'continue',
          trigger: {
            reason: retryTrigger.reason,
            retryAfterMs: retryTrigger.retryAfterMs,
          },
          rotationMessage: errMsg,
        };
      }
    }

    logger.error(
      { ...logContext, provider: 'claude', err: attempt.thrownError },
      'Rotated Claude account also threw',
    );
    return { type: 'error' };
  }

  const output = attempt.output;
  if (!output) {
    logger.error(
      { ...logContext, provider: 'claude' },
      'Rotated Claude account produced no output object',
    );
    return { type: 'error' };
  }

  if (
    !attempt.sawOutput &&
    attempt.streamedTriggerReason &&
    output.status !== 'error'
  ) {
    return {
      type: 'continue',
      trigger: {
        reason: attempt.streamedTriggerReason.reason,
        retryAfterMs: attempt.streamedTriggerReason.retryAfterMs,
      },
      rotationMessage: getAgentOutputText(output) ?? undefined,
    };
  }

  if (!attempt.sawOutput && attempt.sawSuccessNullResult) {
    logger.warn(
      { ...logContext, provider: 'claude' },
      'All rotated tokens returned success with null result',
    );
    return { type: 'error', trigger: { reason: 'success-null-result' } };
  }

  if (output.status === 'error') {
    if (!attempt.sawOutput) {
      const retryTrigger = attempt.streamedTriggerReason
        ? {
            shouldRetry: true,
            reason: attempt.streamedTriggerReason.reason,
            retryAfterMs: attempt.streamedTriggerReason.retryAfterMs,
          }
        : classifyRotationTrigger(output.error);
      if (retryTrigger.shouldRetry) {
        return {
          type: 'continue',
          trigger: {
            reason: retryTrigger.reason,
            retryAfterMs: retryTrigger.retryAfterMs,
          },
          rotationMessage: output.error ?? undefined,
        };
      }
    }

    logger.error(
      { ...logContext, provider: 'claude', error: output.error },
      'Rotated Claude account failed',
    );
    return { type: 'error' };
  }

  markTokenHealthy();
  clearGlobalFailover();
  return { type: 'success', sawOutput: attempt.sawOutput };
}

function evaluateCodexAttempt(
  attempt: CodexRotationAttemptResult,
  logContext: Record<string, unknown>,
): CodexAttemptOutcome {
  if (attempt.thrownError) {
    const errMsg = getErrorMessage(attempt.thrownError);
    const retryTrigger = detectCodexRotationTrigger(errMsg);
    if (retryTrigger.shouldRotate) {
      return {
        type: 'continue',
        trigger: { reason: retryTrigger.reason },
        rotationMessage: errMsg,
      };
    }

    logger.error(
      { ...logContext, provider: 'codex', err: attempt.thrownError },
      'Rotated Codex account also threw',
    );
    return { type: 'error' };
  }

  const output = attempt.output;
  if (!output) {
    logger.error(
      { ...logContext, provider: 'codex' },
      'Rotated Codex account produced no output object',
    );
    return { type: 'error' };
  }

  if (
    !attempt.sawOutput &&
    typeof output.error === 'string' &&
    output.error.length > 0
  ) {
    const retryTrigger =
      attempt.streamedTriggerReason &&
      isCodexRotationReason(attempt.streamedTriggerReason.reason)
        ? {
            shouldRotate: true as const,
            reason: attempt.streamedTriggerReason.reason,
          }
        : detectCodexRotationTrigger(output.error);
    if (retryTrigger.shouldRotate) {
      return {
        type: 'continue',
        trigger: { reason: retryTrigger.reason },
        rotationMessage: output.error,
      };
    }

    logger.error(
      { ...logContext, provider: 'codex', error: output.error },
      'Rotated Codex account returned an error field without visible output',
    );
    return { type: 'error' };
  }

  if (
    !attempt.sawOutput &&
    attempt.streamedTriggerReason &&
    output.status !== 'error'
  ) {
    if (!isCodexRotationReason(attempt.streamedTriggerReason.reason)) {
      logger.error(
        {
          ...logContext,
          provider: 'codex',
          reason: attempt.streamedTriggerReason.reason,
        },
        'Unexpected non-Codex streamed trigger while rotating Codex account',
      );
      return { type: 'error' };
    }
    return {
      type: 'continue',
      trigger: {
        reason: attempt.streamedTriggerReason.reason,
      },
      rotationMessage: getAgentOutputText(output) ?? undefined,
    };
  }

  if (output.status === 'error') {
    const retryTrigger =
      attempt.streamedTriggerReason &&
      isCodexRotationReason(attempt.streamedTriggerReason.reason)
        ? {
            shouldRotate: true as const,
            reason: attempt.streamedTriggerReason.reason,
          }
        : detectCodexRotationTrigger(output.error);
    if (retryTrigger.shouldRotate) {
      return {
        type: 'continue',
        trigger: { reason: retryTrigger.reason },
        rotationMessage: output.error ?? undefined,
      };
    }

    logger.error(
      { ...logContext, provider: 'codex', error: output.error },
      'Rotated Codex account failed',
    );
    return { type: 'error' };
  }

  markCodexTokenHealthy();
  return { type: 'success' };
}

// ── Shared rotation loop ─────────────────────────────────────────

/**
 * Retry a Claude request by rotating through available tokens.
 *
 * Returns 'success' if a rotated token worked, or 'error' if all
 * tokens are exhausted or the error is non-retryable.
 */
export async function runClaudeRotationLoop(
  initialTrigger: TriggerInfo,
  runAttempt: () => Promise<RotationAttemptResult>,
  logContext: Record<string, unknown>,
  rotationMessage?: string,
  options: ClaudeRotationLoopOptions = {},
): Promise<RotationOutcome> {
  let trigger = initialTrigger;
  let lastRotationMessage = rotationMessage;
  let sameAccountTransientRetries = 0;
  const attemptedForcedRefreshIndexes = new Set<number>();

  while (true) {
    if (
      shouldRetryClaudeSameAccount(trigger.reason) &&
      sameAccountTransientRetries < MAX_CLAUDE_TRANSIENT_SAME_ACCOUNT_RETRIES
    ) {
      sameAccountTransientRetries += 1;
      logger.info(
        {
          ...logContext,
          reason: trigger.reason,
          attempt: sameAccountTransientRetries,
          maxAttempts: MAX_CLAUDE_TRANSIENT_SAME_ACCOUNT_RETRIES,
        },
        'Claude transient provider failure, retrying same account before fallback',
      );

      await options.beforeTransientSameAccountRetry?.({
        trigger,
        attempt: sameAccountTransientRetries,
        maxAttempts: MAX_CLAUDE_TRANSIENT_SAME_ACCOUNT_RETRIES,
      });

      const retryAttemptOutcome = evaluateClaudeAttempt(
        await runAttempt(),
        logContext,
      );
      if (retryAttemptOutcome.type === 'success') {
        return retryAttemptOutcome;
      }
      if (retryAttemptOutcome.type === 'error') {
        return retryAttemptOutcome;
      }

      trigger = retryAttemptOutcome.trigger;
      lastRotationMessage = retryAttemptOutcome.rotationMessage;
      continue;
    }

    if (!shouldRotateClaudeToken(trigger.reason)) {
      break;
    }

    if (trigger.reason === 'auth-expired') {
      const tokenIndex = getCurrentTokenIndex();
      if (
        tokenIndex != null &&
        !attemptedForcedRefreshIndexes.has(tokenIndex)
      ) {
        attemptedForcedRefreshIndexes.add(tokenIndex);
        const refreshedToken = await forceRefreshToken(tokenIndex);
        if (refreshedToken) {
          logger.info(
            { ...logContext, tokenIndex },
            'Claude auth-expired recovered by force-refreshing current token',
          );

          const refreshAttemptOutcome = evaluateClaudeAttempt(
            await runAttempt(),
            logContext,
          );
          if (refreshAttemptOutcome.type === 'success') {
            return refreshAttemptOutcome;
          }
          if (refreshAttemptOutcome.type === 'error') {
            return refreshAttemptOutcome;
          }

          trigger = refreshAttemptOutcome.trigger;
          lastRotationMessage = refreshAttemptOutcome.rotationMessage;
          continue;
        }
      }
    }

    if (
      !(
        getTokenCount() > 1 &&
        // Respect per-token cooldowns so exhausted auth/quota failures can
        // terminate instead of cycling forever.
        rotateToken(lastRotationMessage)
      )
    ) {
      break;
    }

    logger.info(
      { ...logContext, reason: trigger.reason },
      'Claude account unavailable, retrying with rotated account',
    );

    const rotatedAttemptOutcome = evaluateClaudeAttempt(
      await runAttempt(),
      logContext,
    );
    if (rotatedAttemptOutcome.type === 'success') {
      return rotatedAttemptOutcome;
    }
    if (rotatedAttemptOutcome.type === 'error') {
      return rotatedAttemptOutcome;
    }

    trigger = rotatedAttemptOutcome.trigger;
    lastRotationMessage = rotatedAttemptOutcome.rotationMessage;
  }

  // ── All tokens exhausted ──
  logger.warn(
    { ...logContext, reason: trigger.reason },
    `All Claude tokens exhausted (${trigger.reason})`,
  );
  return { type: 'error', trigger };
}

export async function runCodexRotationLoop(
  initialTrigger: { reason: CodexRotationReason; message?: string },
  runAttempt: () => Promise<CodexRotationAttemptResult>,
  logContext: Record<string, unknown>,
  rotationMessage?: string,
): Promise<CodexRotationOutcome> {
  let trigger = initialTrigger;
  let lastRotationMessage = rotationMessage;

  while (getCodexAccountCount() > 1) {
    const rotationReasonMessage =
      lastRotationMessage ?? trigger.message ?? trigger.reason;
    if (!rotateCodexToken(rotationReasonMessage)) {
      break;
    }

    logger.info(
      { ...logContext, reason: trigger.reason },
      'Codex account unhealthy, retrying with rotated account',
    );

    const rotatedAttemptOutcome = evaluateCodexAttempt(
      await runAttempt(),
      logContext,
    );
    if (rotatedAttemptOutcome.type === 'success') {
      return rotatedAttemptOutcome;
    }
    if (rotatedAttemptOutcome.type === 'error') {
      return rotatedAttemptOutcome;
    }

    trigger = rotatedAttemptOutcome.trigger;
    lastRotationMessage = rotatedAttemptOutcome.rotationMessage;
  }

  return { type: 'error' };
}
