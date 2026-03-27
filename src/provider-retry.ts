/**
 * Shared Claude retry-with-rotation loop (SSOT).
 *
 * Extracted from message-agent-executor.ts and task-scheduler.ts
 * to eliminate the ~255-line structural duplication.
 */

import {
  classifyRotationTrigger,
  shouldRotateClaudeToken,
  type AgentTriggerReason,
} from './agent-error-detection.js';
import { logger } from './logger.js';
import { getErrorMessage } from './utils.js';
import {
  rotateToken,
  getTokenCount,
  markTokenHealthy,
} from './token-rotation.js';

// ── Types ────────────────────────────────────────────────────────

export interface TriggerInfo {
  reason: AgentTriggerReason;
  retryAfterMs?: number;
}

export interface RotationAttemptResult {
  output?: { status: string; result?: string | null; error?: string | null };
  thrownError?: unknown;
  sawOutput: boolean;
  sawSuccessNullResult?: boolean;
  streamedTriggerReason?: TriggerInfo;
}

export type RotationOutcome =
  | { type: 'success' }
  | { type: 'error'; trigger?: TriggerInfo };

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
): Promise<RotationOutcome> {
  let trigger = initialTrigger;
  let lastRotationMessage = rotationMessage;

  while (
    shouldRotateClaudeToken(trigger.reason) &&
    getTokenCount() > 1 &&
    // Respect per-token cooldowns so exhausted auth/quota failures can
    // terminate instead of cycling forever.
    rotateToken(lastRotationMessage)
  ) {
    logger.info(
      { ...logContext, reason: trigger.reason },
      'Claude account unavailable, retrying with rotated account',
    );

    const attempt = await runAttempt();

    // ── Thrown error (exception from spawn/process) ──
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
          trigger = {
            reason: retryTrigger.reason,
            retryAfterMs: retryTrigger.retryAfterMs,
          };
          lastRotationMessage = errMsg;
          continue;
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

    // ── Streamed trigger in non-error success ──
    if (
      !attempt.sawOutput &&
      attempt.streamedTriggerReason &&
      output.status !== 'error'
    ) {
      trigger = {
        reason: attempt.streamedTriggerReason.reason,
        retryAfterMs: attempt.streamedTriggerReason.retryAfterMs,
      };
      lastRotationMessage =
        typeof output.result === 'string' ? output.result : undefined;
      continue;
    }

    // ── Success with null result ──
    if (!attempt.sawOutput && attempt.sawSuccessNullResult) {
      logger.warn(
        { ...logContext, provider: 'claude' },
        'All rotated tokens returned success with null result',
      );
      return { type: 'error', trigger: { reason: 'success-null-result' } };
    }

    // ── Error status ──
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
          trigger = {
            reason: retryTrigger.reason,
            retryAfterMs: retryTrigger.retryAfterMs,
          };
          lastRotationMessage = output.error ?? undefined;
          continue;
        }
      }

      logger.error(
        { ...logContext, provider: 'claude', error: output.error },
        'Rotated Claude account failed',
      );
      return { type: 'error' };
    }

    // ── Success ──
    markTokenHealthy();
    return { type: 'success' };
  }

  // ── All tokens exhausted ──
  logger.warn(
    { ...logContext, reason: trigger.reason },
    `All Claude tokens exhausted (${trigger.reason})`,
  );
  return { type: 'error', trigger };
}
