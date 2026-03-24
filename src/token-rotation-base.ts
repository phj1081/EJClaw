/**
 * Token Rotation Base Utilities (SSOT)
 *
 * Shared algorithms for Claude and Codex token rotation.
 * Extracted from token-rotation.ts and codex-token-rotation.ts
 * to eliminate duplicate implementations.
 */

export const BUFFER_MS = 3 * 60_000; // 3 min buffer after reset time
export const DEFAULT_COOLDOWN_MS = 3_600_000; // 1 hour fallback

/**
 * Parse "try again at Mar 26th, 2026 9:00 AM" or "resets at ..." from
 * an error message. Returns timestamp in ms, or null if not found.
 *
 * Uses the wider regex from token-rotation.ts that also matches
 * "resets at" patterns (codex-token-rotation only matched "try again at").
 */
export function parseRetryAfterFromError(error?: string): number | null {
  if (!error) return null;
  const match = error.match(
    /(?:try again at|resets?\s+(?:at\s+)?)\s*(\w+ \d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  );
  if (!match) return null;
  try {
    const cleaned = match[1].replace(/(\d+)(?:st|nd|rd|th)/i, '$1');
    const ts = new Date(cleaned).getTime();
    if (Number.isNaN(ts)) return null;
    return ts;
  } catch {
    return null;
  }
}

/**
 * Compute when a rate-limited token should become available again.
 * Parses retry-after from error message, falling back to DEFAULT_COOLDOWN_MS.
 */
export function computeCooldownUntil(error?: string): number {
  const retryAt = parseRetryAfterFromError(error);
  if (retryAt) return retryAt + BUFFER_MS;
  return Date.now() + DEFAULT_COOLDOWN_MS;
}

/**
 * Find the next available (non-rate-limited) item in a rotation pool.
 * Returns the index, or null if all are exhausted.
 *
 * This is the shared rotation algorithm used by both Claude token rotation
 * and Codex account rotation.
 */
export function findNextAvailable<
  T extends { rateLimitedUntil: number | null },
>(
  items: T[],
  currentIndex: number,
  opts?: { ignoreRateLimits?: boolean },
): number | null {
  const now = Date.now();
  const ignoreRL = opts?.ignoreRateLimits ?? false;

  for (let i = 1; i < items.length; i++) {
    const idx = (currentIndex + i) % items.length;
    const item = items[idx];
    if (ignoreRL || !item.rateLimitedUntil || item.rateLimitedUntil <= now) {
      return idx;
    }
  }

  return null;
}
