/**
 * OAuth Token Rotation
 *
 * Rotates between multiple Claude Code OAuth tokens when
 * rate-limited. Tokens are stored as comma-separated values in the
 * canonical CLAUDE_CODE_OAUTH_TOKENS env var and fall through to the
 * legacy single-token CLAUDE_CODE_OAUTH_TOKEN when needed.
 *
 * On rate-limit:  rotate to next token
 * All exhausted:  surface error to caller
 */

import path from 'path';

import { DATA_DIR } from './config.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import {
  computeCooldownUntil,
  findNextAvailable,
} from './token-rotation-base.js';
import { readJsonFile, writeJsonFile } from './utils.js';

const STATE_FILE = path.join(DATA_DIR, 'token-rotation-state.json');

interface TokenState {
  token: string;
  rateLimitedUntil: number | null;
}

const tokens: TokenState[] = [];
let currentIndex = 0;
let initialized = false;

export function getConfiguredClaudeTokens(options?: {
  multi?: string | undefined;
  single?: string | undefined;
}): string[] {
  const multi = options?.multi ?? getEnv('CLAUDE_CODE_OAUTH_TOKENS');
  const single = options?.single ?? getEnv('CLAUDE_CODE_OAUTH_TOKEN');

  if (multi) {
    return multi
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
  }

  return single ? [single] : [];
}

export function initTokenRotation(): void {
  if (initialized) return;
  initialized = true;

  const raw = getConfiguredClaudeTokens();

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
    writeJsonFile(STATE_FILE, state);
  } catch (err) {
    logger.warn(
      { stateFile: STATE_FILE, err },
      'Failed to persist Claude token rotation state',
    );
  }
}

function loadState(quiet = false): void {
  const state = readJsonFile<{
    currentIndex?: number;
    rateLimits?: (number | null)[];
  }>(STATE_FILE);
  if (!state) return;

  const now = Date.now();
  if (
    typeof state.currentIndex === 'number' &&
    state.currentIndex < tokens.length
  ) {
    currentIndex = state.currentIndex;
  }
  if (Array.isArray(state.rateLimits)) {
    for (let i = 0; i < Math.min(state.rateLimits.length, tokens.length); i++) {
      const until = state.rateLimits[i];
      if (typeof until === 'number' && until > now) {
        tokens[i].rateLimitedUntil = until;
      } else {
        tokens[i].rateLimitedUntil = null;
      }
    }
  }
  if (!quiet) {
    logger.info(
      { currentIndex, tokenCount: tokens.length },
      'Token rotation state restored',
    );
  }
}

/**
 * Re-read the on-disk rotation state (written by any service).
 * Call before dashboard renders so the renderer picks up rotations
 * performed by another Claude service process.
 */
export function reloadTokenRotationStateFromDisk(): void {
  if (tokens.length <= 1) return;
  loadState(true);
}

function refreshRuntimeTokenSelection(): void {
  if (tokens.length <= 1) return;

  const now = Date.now();
  const previousIndex = currentIndex;
  let expiredCooldowns = 0;

  for (const token of tokens) {
    if (token.rateLimitedUntil && token.rateLimitedUntil <= now) {
      token.rateLimitedUntil = null;
      expiredCooldowns += 1;
    }
  }

  const preferredIndex = tokens.findIndex(
    (token) => !token.rateLimitedUntil || token.rateLimitedUntil <= now,
  );
  if (preferredIndex !== -1) {
    currentIndex = preferredIndex;
  }

  if (expiredCooldowns > 0 || currentIndex !== previousIndex) {
    logger.info(
      {
        previousIndex,
        currentIndex,
        expiredCooldowns,
      },
      'Refreshed Claude token runtime selection',
    );
    saveState();
  }
}

/** Get the current active token. */
export function getCurrentToken(): string | undefined {
  if (tokens.length === 0) return getConfiguredClaudeTokens()[0];
  refreshRuntimeTokenSelection();
  return tokens[currentIndex % tokens.length]?.token;
}

/** Get the current active token index. */
export function getCurrentTokenIndex(): number | null {
  if (tokens.length === 0) return null;
  refreshRuntimeTokenSelection();
  return currentIndex % tokens.length;
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

  const previousIndex = currentIndex;
  const cooldownUntil = computeCooldownUntil(errorMessage);
  tokens[currentIndex].rateLimitedUntil = cooldownUntil;

  const nextIdx = findNextAvailable(tokens, currentIndex, opts);
  if (nextIdx !== null) {
    tokens[nextIdx].rateLimitedUntil = null;
    currentIndex = nextIdx;
    logger.info(
      {
        transition: 'rotation:execute',
        fromIndex: previousIndex,
        toIndex: currentIndex,
        totalTokens: tokens.length,
        ignoreRL: opts?.ignoreRateLimits ?? false,
        cooldownUntil:
          cooldownUntil != null ? new Date(cooldownUntil).toISOString() : null,
        reason: errorMessage ?? null,
      },
      `Rotated to token #${currentIndex + 1}/${tokens.length}`,
    );
    saveState();
    return true;
  }

  logger.warn(
    {
      transition: 'rotation:skip',
      fromIndex: previousIndex,
      totalTokens: tokens.length,
      ignoreRL: opts?.ignoreRateLimits ?? false,
      cooldownUntil:
        cooldownUntil != null ? new Date(cooldownUntil).toISOString() : null,
      reason: errorMessage ?? null,
    },
    'All tokens are rate-limited, no available tokens',
  );
  return false;
}

/** Clear rate-limit flag for the current token (on successful response). */
export function markTokenHealthy(): void {
  if (tokens.length === 0) return;
  const state = tokens[currentIndex];
  let updated = false;
  if (state?.rateLimitedUntil) {
    const previousCooldownUntil = state.rateLimitedUntil;
    state.rateLimitedUntil = null;
    updated = true;
    logger.info(
      {
        transition: 'rotation:clear-rate-limit',
        tokenIndex: currentIndex,
        cooldownUntil: new Date(previousCooldownUntil).toISOString(),
      },
      'Cleared Claude token rate-limit state after successful response',
    );
  }
  refreshRuntimeTokenSelection();
  if (updated) saveState();
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
  refreshRuntimeTokenSelection();
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
  refreshRuntimeTokenSelection();
  const now = Date.now();
  return {
    total: tokens.length,
    currentIndex,
    rateLimited: tokens.filter(
      (t) => t.rateLimitedUntil && t.rateLimitedUntil > now,
    ).length,
  };
}

export function hasAvailableClaudeToken(): boolean {
  if (tokens.length === 0) {
    return getConfiguredClaudeTokens().length > 0;
  }
  refreshRuntimeTokenSelection();
  const now = Date.now();
  return tokens.some(
    (token) => !token.rateLimitedUntil || token.rateLimitedUntil <= now,
  );
}
