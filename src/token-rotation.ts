/**
 * OAuth Token Rotation
 *
 * Rotates between multiple CLAUDE_CODE_OAUTH_TOKEN values when
 * rate-limited. Tokens are stored as comma-separated values in
 * CLAUDE_CODE_OAUTH_TOKENS env var. Falls through to the single
 * CLAUDE_CODE_OAUTH_TOKEN if multi-token is not configured.
 *
 * On rate-limit:  rotate to next token
 * All exhausted:  fall through to provider fallback (Kimi etc.)
 */

import { logger } from './logger.js';

interface TokenState {
  token: string;
  rateLimitedUntil: number | null;
}

const tokens: TokenState[] = [];
let currentIndex = 0;
let initialized = false;

export function initTokenRotation(): void {
  if (initialized) return;
  initialized = true;

  const multi = process.env.CLAUDE_CODE_OAUTH_TOKENS;
  const single = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  const raw = multi
    ? multi.split(',').map((t) => t.trim()).filter(Boolean)
    : single
      ? [single]
      : [];

  for (const token of raw) {
    tokens.push({ token, rateLimitedUntil: null });
  }

  if (tokens.length > 1) {
    logger.info(
      { count: tokens.length },
      `Token rotation initialized with ${tokens.length} tokens`,
    );
  }
}

/** Get the current active token. */
export function getCurrentToken(): string | undefined {
  if (tokens.length === 0) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return tokens[currentIndex % tokens.length]?.token;
}

/**
 * Try to rotate to the next available (non-rate-limited) token.
 * Returns true if a fresh token was found, false if all are exhausted.
 */
export function rotateToken(): boolean {
  if (tokens.length <= 1) return false;

  const now = Date.now();
  // Mark current as rate-limited (default 1 hour)
  tokens[currentIndex].rateLimitedUntil = now + 3_600_000;

  // Find next available token
  for (let i = 1; i < tokens.length; i++) {
    const idx = (currentIndex + i) % tokens.length;
    const state = tokens[idx];
    if (!state.rateLimitedUntil || state.rateLimitedUntil <= now) {
      state.rateLimitedUntil = null;
      currentIndex = idx;
      logger.info(
        { tokenIndex: currentIndex, totalTokens: tokens.length },
        `Rotated to token #${currentIndex + 1}/${tokens.length}`,
      );
      return true;
    }
  }

  logger.warn(
    { totalTokens: tokens.length },
    'All tokens are rate-limited, falling through to provider fallback',
  );
  return false;
}

/** Clear rate-limit flag for the current token (on successful response). */
export function markTokenHealthy(): void {
  if (tokens.length === 0) return;
  const state = tokens[currentIndex];
  if (state?.rateLimitedUntil) {
    state.rateLimitedUntil = null;
  }
}

/** Number of configured tokens. */
export function getTokenCount(): number {
  return tokens.length;
}

/** Diagnostic info. */
export function getTokenRotationInfo(): {
  total: number;
  currentIndex: number;
  rateLimited: number;
} {
  const now = Date.now();
  return {
    total: tokens.length,
    currentIndex,
    rateLimited: tokens.filter(
      (t) => t.rateLimitedUntil && t.rateLimitedUntil > now,
    ).length,
  };
}
