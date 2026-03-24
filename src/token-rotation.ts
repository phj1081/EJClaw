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

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const STATE_FILE = path.join(DATA_DIR, 'token-rotation-state.json');

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

  const envFile = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKENS',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]);
  const multi =
    process.env.CLAUDE_CODE_OAUTH_TOKENS || envFile.CLAUDE_CODE_OAUTH_TOKENS;
  const single =
    process.env.CLAUDE_CODE_OAUTH_TOKEN || envFile.CLAUDE_CODE_OAUTH_TOKEN;

  const raw = multi
    ? multi
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : single
      ? [single]
      : [];

  for (const token of raw) {
    tokens.push({ token, rateLimitedUntil: null });
  }

  if (tokens.length > 1) {
    loadState();
    logger.info(
      { count: tokens.length, activeIndex: currentIndex },
      `Token rotation initialized with ${tokens.length} tokens`,
    );
  }
}

function saveState(): void {
  try {
    const state = {
      currentIndex,
      rateLimits: tokens.map((t) => t.rateLimitedUntil),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

function loadState(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const now = Date.now();
    if (
      typeof state.currentIndex === 'number' &&
      state.currentIndex < tokens.length
    ) {
      currentIndex = state.currentIndex;
    }
    if (Array.isArray(state.rateLimits)) {
      for (
        let i = 0;
        i < Math.min(state.rateLimits.length, tokens.length);
        i++
      ) {
        const until = state.rateLimits[i];
        if (typeof until === 'number' && until > now) {
          tokens[i].rateLimitedUntil = until;
        }
      }
    }
    logger.info(
      { currentIndex, tokenCount: tokens.length },
      'Token rotation state restored',
    );
  } catch {
    /* start fresh */
  }
}

const BUFFER_MS = 3 * 60_000;
const DEFAULT_COOLDOWN_MS = 3_600_000;

function parseRetryAfterFromError(error?: string): number | null {
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

function computeCooldownUntil(error?: string): number {
  const retryAt = parseRetryAfterFromError(error);
  if (retryAt) return retryAt + BUFFER_MS;
  return Date.now() + DEFAULT_COOLDOWN_MS;
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
export function rotateToken(
  errorMessage?: string,
  opts?: { ignoreRateLimits?: boolean },
): boolean {
  if (tokens.length <= 1) return false;

  const now = Date.now();
  tokens[currentIndex].rateLimitedUntil = computeCooldownUntil(errorMessage);
  const ignoreRL = opts?.ignoreRateLimits ?? false;

  // Find next available token
  for (let i = 1; i < tokens.length; i++) {
    const idx = (currentIndex + i) % tokens.length;
    const state = tokens[idx];
    if (ignoreRL || !state.rateLimitedUntil || state.rateLimitedUntil <= now) {
      state.rateLimitedUntil = null;
      currentIndex = idx;
      logger.info(
        { tokenIndex: currentIndex, totalTokens: tokens.length, ignoreRL },
        `Rotated to token #${currentIndex + 1}/${tokens.length}`,
      );
      saveState();
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
    saveState();
  }
}

/** Number of configured tokens. */
export function getTokenCount(): number {
  return tokens.length;
}

/** Get all configured tokens (masked for display, raw for API calls). */
export function getAllTokens(): {
  index: number;
  token: string;
  masked: string;
  isActive: boolean;
  isRateLimited: boolean;
}[] {
  const now = Date.now();
  return tokens.map((t, i) => ({
    index: i,
    token: t.token,
    masked: `${t.token.slice(0, 20)}...${t.token.slice(-4)}`,
    isActive: i === currentIndex,
    isRateLimited: Boolean(t.rateLimitedUntil && t.rateLimitedUntil > now),
  }));
}

/** Update the access token value for a specific index (after OAuth refresh). */
export function updateTokenValue(index: number, newAccessToken: string): void {
  if (index < 0 || index >= tokens.length) {
    logger.warn(
      { index, total: tokens.length },
      'updateTokenValue: index out of range',
    );
    return;
  }
  tokens[index].token = newAccessToken;
  logger.info(
    {
      index,
      masked: `${newAccessToken.slice(0, 20)}...${newAccessToken.slice(-4)}`,
    },
    'Token value updated after OAuth refresh',
  );
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
