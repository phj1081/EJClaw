import { TIMEZONE } from './config.js';
import { getRecentConsecutiveErrors, updateTask } from './db.js';
import { logger } from './logger.js';
import type { ScheduledTask } from './types.js';

const CONSECUTIVE_FAILURES_THRESHOLD = 3;
const DEFAULT_BACKOFF_STEPS_MS = [
  3_600_000, // 1 hour
  14_400_000, // 4 hours
  43_200_000, // 12 hours
];

// Patterns that indicate a quota / auth / billing error (not transient).
const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota exceeded/i,
  /billing/i,
  /insufficient.*(credit|fund|balance)/i,
  /exceeded.*plan/i,
  /purchase more credits/i,
];

export interface SuspensionResult {
  suspended: boolean;
  suspendedUntil: string | null;
  reason: string | null;
}

/**
 * Detect if a quota/auth error message contains a human-readable
 * retry-after date like "try again at Mar 26th, 2026 9:00 AM".
 */
export function parseRetryAfterDate(error: string): Date | null {
  const match = error.match(
    /try again (?:at|after)\s+(.+?\d{4}[\s,]+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  );
  if (!match) return null;

  const raw = match[1]
    .replace(/(\d+)(?:st|nd|rd|th)/g, '$1')
    .replace(/,\s*/g, ', ');

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  // Sanity: must be in the future and within 30 days
  const now = Date.now();
  if (parsed.getTime() <= now || parsed.getTime() > now + 30 * 86_400_000) {
    return null;
  }
  return parsed;
}

function isQuotaError(error: string): boolean {
  return QUOTA_PATTERNS.some((p) => p.test(error));
}

function computeBackoffMs(consecutiveCount: number): number {
  const idx = Math.min(
    consecutiveCount - CONSECUTIVE_FAILURES_THRESHOLD,
    DEFAULT_BACKOFF_STEPS_MS.length - 1,
  );
  return DEFAULT_BACKOFF_STEPS_MS[Math.max(0, idx)];
}

/**
 * Check recent run history and decide whether to suspend a task.
 * Returns suspension info if the task should be suspended.
 */
export function evaluateTaskSuspension(
  task: ScheduledTask,
  latestError: string,
): SuspensionResult {
  const noSuspension: SuspensionResult = {
    suspended: false,
    suspendedUntil: null,
    reason: null,
  };

  if (!isQuotaError(latestError)) return noSuspension;

  const recentErrors = getRecentConsecutiveErrors(
    task.id,
    CONSECUTIVE_FAILURES_THRESHOLD,
  );
  // +1 because the current error hasn't been logged yet
  const totalConsecutive = recentErrors.length + 1;

  if (totalConsecutive < CONSECUTIVE_FAILURES_THRESHOLD) return noSuspension;

  // Try to parse an explicit retry-after date from the error
  const retryDate = parseRetryAfterDate(latestError);
  const suspendedUntil = retryDate
    ? retryDate.toISOString()
    : new Date(Date.now() + computeBackoffMs(totalConsecutive)).toISOString();

  return {
    suspended: true,
    suspendedUntil,
    reason: latestError.slice(0, 200),
  };
}

/**
 * Apply suspension to a task in the DB.
 */
export function suspendTask(taskId: string, suspendedUntil: string): void {
  updateTask(taskId, { suspended_until: suspendedUntil });
  logger.info(
    { taskId, suspendedUntil },
    'Task suspended due to repeated quota/auth errors',
  );
}

/**
 * Format the suspension notification for Discord.
 */
export function formatSuspensionNotice(
  task: ScheduledTask,
  suspendedUntil: string,
  reason: string,
): string {
  const resumeLabel = new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  }).format(new Date(suspendedUntil));

  const lines = [
    `⏸ 태스크 일시 중단`,
    `- 사유: ${reason}`,
    `- 자동 재개: ${resumeLabel}`,
    `- 태스크 ID: \`${task.id}\``,
  ];
  return lines.join('\n');
}
