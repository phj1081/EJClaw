/**
 * Shared Claude retry-with-rotation loop (SSOT).
 *
 * Extracted from message-agent-executor.ts and task-scheduler.ts
 * to eliminate the ~255-line structural duplication.
 */

import { shouldRotateClaudeToken } from './agent-error-detection.js';
import { logger } from './logger.js';
import { getErrorMessage } from './utils.js';
import {
  detectFallbackTrigger,
  markPrimaryCooldown,
} from './provider-fallback.js';
import {
  rotateToken,
  getTokenCount,
  markTokenHealthy,
} from './token-rotation.js';

// ── Types ────────────────────────────────────────────────────────

export interface TriggerInfo {
  reason: string;
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
  | { type: 'error'; message?: string }
  | { type: 'needs-fallback'; trigger: TriggerInfo }
  | { type: 'no-fallback'; trigger: TriggerInfo }; // usage-exhausted/auth-expired/org-access-denied

// ── Shared rotation loop ─────────────────────────────────────────

/**
 * Retry a Claude request by rotating through available tokens.
 *
 * Returns a discriminated outcome — the caller decides what to do
 * with 'needs-fallback' (e.g. run Kimi fallback) or 'no-fallback'.
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
    rotateToken(lastRotationMessage, { ignoreRateLimits: true })
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
              shouldFallback: true,
              reason: attempt.streamedTriggerReason.reason,
              retryAfterMs: attempt.streamedTriggerReason.retryAfterMs,
            }
          : detectFallbackTrigger(errMsg);
        if (retryTrigger.shouldFallback) {
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

    // ── Success with null result (MAE-specific, TaskScheduler ignores) ──
    if (!attempt.sawOutput && attempt.sawSuccessNullResult) {
      return {
        type: 'needs-fallback',
        trigger: { reason: 'success-null-result' },
      };
    }

    // ── Error status ──
    if (output.status === 'error') {
      if (!attempt.sawOutput) {
        const retryTrigger = attempt.streamedTriggerReason
          ? {
              shouldFallback: true,
              reason: attempt.streamedTriggerReason.reason,
              retryAfterMs: attempt.streamedTriggerReason.retryAfterMs,
            }
          : detectFallbackTrigger(output.error);
        if (retryTrigger.shouldFallback) {
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

  // Usage/auth/org access failures: don't fall back to Kimi
  if (
    trigger.reason === 'usage-exhausted' ||
    trigger.reason === 'auth-expired' ||
    trigger.reason === 'org-access-denied'
  ) {
    markPrimaryCooldown(trigger.reason, trigger.retryAfterMs);
    logger.info(
      { ...logContext, reason: trigger.reason },
      `All Claude tokens ${trigger.reason}, silently skipping (no Kimi fallback)`,
    );
    return { type: 'no-fallback', trigger };
  }

  return { type: 'needs-fallback', trigger };
}
