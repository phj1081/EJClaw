/**
 * Codex OAuth Token Rotation
 *
 * Rotates between multiple Codex (ChatGPT) OAuth accounts when
 * rate-limited. Each account is stored as a separate auth.json in
 * ~/.codex-accounts/{n}/auth.json.
 *
 * The active account's auth.json is copied to the session directory
 * before each agent spawn (existing behavior in agent-runner-environment).
 * On rate-limit, we rotate to the next account.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  classifyAgentError,
  classifyCodexAuthError,
  type CodexRotationReason,
} from './agent-error-detection.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  computeCooldownUntil,
  findNextAvailable,
  parseRetryAfterFromError,
} from './token-rotation-base.js';
import { readJsonFile, writeJsonFile } from './utils.js';

const STATE_FILE = path.join(DATA_DIR, 'codex-rotation-state.json');

interface CodexAccount {
  index: number;
  authPath: string;
  accountId: string;
  planType: string;
  subscriptionUntil: string | null;
  rateLimitedUntil: number | null;
  lastUsagePct?: number;
  lastUsageD7Pct?: number;
  resetAt?: string;
  resetD7At?: string;
}

export type CodexRotationTriggerResult =
  | {
      shouldRotate: false;
      reason: '';
    }
  | {
      shouldRotate: true;
      reason: CodexRotationReason;
    };

function parseJwtAuth(idToken: string): {
  planType: string;
  expiresAt: string | null;
} {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return { planType: '?', expiresAt: null };
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );
    const auth = payload?.['https://api.openai.com/auth'] || {};
    return {
      planType: auth.chatgpt_plan_type || '?',
      expiresAt: auth.chatgpt_subscription_active_until || null,
    };
  } catch {
    return { planType: '?', expiresAt: null };
  }
}

const accounts: CodexAccount[] = [];
let currentIndex = 0;
let initialized = false;

const ACCOUNTS_DIR = path.join(os.homedir(), '.codex-accounts');
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_AUTH_PATH = path.join(DEFAULT_CODEX_DIR, 'auth.json');

function loadCodexAccount(
  authPath: string,
  fallbackAccountId: string,
): boolean {
  const data = readJsonFile<{
    tokens?: { account_id?: string; id_token?: string };
  }>(authPath);
  if (!data) {
    logger.warn({ authPath }, 'Failed to parse codex account auth.json');
    return false;
  }

  const accountId = data?.tokens?.account_id || fallbackAccountId;
  const jwt = parseJwtAuth(data?.tokens?.id_token || '');
  accounts.push({
    index: accounts.length,
    authPath,
    accountId,
    planType: jwt.planType,
    subscriptionUntil: jwt.expiresAt,
    rateLimitedUntil: null,
  });
  return true;
}

export function initCodexTokenRotation(): void {
  if (initialized) return;
  initialized = true;

  const hasAccountsDir = fs.existsSync(ACCOUNTS_DIR);
  const dirs = hasAccountsDir
    ? fs
        .readdirSync(ACCOUNTS_DIR)
        .filter((d) => /^\d+$/.test(d))
        .sort((a, b) => parseInt(a) - parseInt(b))
    : [];

  if (!hasAccountsDir) {
    logger.info({ dir: ACCOUNTS_DIR }, 'Codex accounts dir not found');
  }

  for (const dir of dirs) {
    const authPath = path.join(ACCOUNTS_DIR, dir, 'auth.json');
    if (!fs.existsSync(authPath)) continue;
    loadCodexAccount(authPath, `account-${dir}`);
  }

  if (dirs.length === 0 && fs.existsSync(DEFAULT_AUTH_PATH)) {
    if (loadCodexAccount(DEFAULT_AUTH_PATH, 'default-account')) {
      logger.info(
        { authPath: DEFAULT_AUTH_PATH },
        'Codex accounts dir absent/empty; using ~/.codex/auth.json fallback',
      );
    }
  }

  if (accounts.length > 1) loadCodexState();
  logger.info(
    { count: accounts.length, dir: ACCOUNTS_DIR, activeIndex: currentIndex },
    `Codex token rotation: ${accounts.length} account(s) found`,
  );
}

function saveCodexState(): void {
  try {
    const state = {
      currentIndex,
      rateLimits: accounts.map((a) => a.rateLimitedUntil),
      usagePcts: accounts.map((a) => a.lastUsagePct ?? null),
      usageD7Pcts: accounts.map((a) => a.lastUsageD7Pct ?? null),
      resetAts: accounts.map((a) => a.resetAt ?? null),
      resetD7Ats: accounts.map((a) => a.resetD7At ?? null),
    };
    writeJsonFile(STATE_FILE, state);
  } catch (err) {
    logger.warn(
      { stateFile: STATE_FILE, err },
      'Failed to persist Codex rotation state',
    );
  }
}

function loadCodexState(quiet = false): void {
  const state = readJsonFile<{
    currentIndex?: number;
    rateLimits?: (number | null)[];
    usagePcts?: (number | null)[];
    usageD7Pcts?: (number | null)[];
    resetAts?: (string | null)[];
    resetD7Ats?: (string | null)[];
  }>(STATE_FILE);
  if (!state) return;

  const now = Date.now();
  if (
    typeof state.currentIndex === 'number' &&
    state.currentIndex < accounts.length
  ) {
    currentIndex = state.currentIndex;
  }
  if (Array.isArray(state.rateLimits)) {
    for (
      let i = 0;
      i < Math.min(state.rateLimits.length, accounts.length);
      i++
    ) {
      const until = state.rateLimits[i];
      if (typeof until === 'number' && until > now) {
        accounts[i].rateLimitedUntil = until;
      } else {
        accounts[i].rateLimitedUntil = null;
      }
    }
  }
  if (Array.isArray(state.usagePcts)) {
    for (
      let i = 0;
      i < Math.min(state.usagePcts.length, accounts.length);
      i++
    ) {
      accounts[i].lastUsagePct =
        typeof state.usagePcts[i] === 'number'
          ? state.usagePcts[i]!
          : undefined;
    }
  }
  if (Array.isArray(state.usageD7Pcts)) {
    for (
      let i = 0;
      i < Math.min(state.usageD7Pcts.length, accounts.length);
      i++
    ) {
      accounts[i].lastUsageD7Pct =
        typeof state.usageD7Pcts[i] === 'number'
          ? state.usageD7Pcts[i]!
          : undefined;
    }
  }
  if (Array.isArray(state.resetAts)) {
    for (let i = 0; i < Math.min(state.resetAts.length, accounts.length); i++) {
      accounts[i].resetAt = state.resetAts[i] ?? undefined;
    }
  }
  if (Array.isArray(state.resetD7Ats)) {
    for (
      let i = 0;
      i < Math.min(state.resetD7Ats.length, accounts.length);
      i++
    ) {
      accounts[i].resetD7At = state.resetD7Ats[i] ?? undefined;
    }
  }
  if (!quiet) {
    logger.info(
      { currentIndex, accountCount: accounts.length },
      'Codex rotation state restored',
    );
  }
}

/**
 * Re-read the on-disk rotation state (written by any service).
 * Call before dashboard renders so the renderer picks up rotations
 * performed by the Codex service process.
 */
export function reloadCodexStateFromDisk(): void {
  if (accounts.length <= 1) return;
  loadCodexState(true);
}

/** Get the auth.json path for the current active account. */
export function getActiveCodexAuthPath(): string | null {
  return getCodexAuthPath();
}

/** Currently active codex account index (after rotation). */
export function getCurrentCodexAccountIndex(): number {
  return accounts.length === 0 ? 0 : currentIndex;
}

/** Find the rotation-array index that owns the given auth.json path. */
export function findCodexAccountIndexByAuthPath(
  authPath: string,
): number | null {
  for (let i = 0; i < accounts.length; i += 1) {
    if (accounts[i]?.authPath === authPath) return i;
  }
  return null;
}

/** Manually switch the active codex account. Clears its rate-limit cooldown. */
export function setCurrentCodexAccountIndex(targetIndex: number): void {
  if (accounts.length === 0) {
    throw new Error('codex token rotation: no accounts loaded');
  }
  if (
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= accounts.length
  ) {
    throw new Error(
      `codex switch: index ${targetIndex} out of range [0..${accounts.length - 1}]`,
    );
  }
  if (targetIndex === currentIndex) return;
  const previous = currentIndex;
  currentIndex = targetIndex;
  // Clear rate-limit on the chosen account so rotation logic doesn't bounce it.
  accounts[targetIndex].rateLimitedUntil = null;
  saveCodexState();
  logger.info(
    {
      transition: 'rotation:manual-switch',
      fromIndex: previous,
      toIndex: currentIndex,
      totalAccounts: accounts.length,
    },
    `Codex switched manually to account #${currentIndex + 1}/${accounts.length}`,
  );
}

export function getCodexAuthPath(
  accountIndex: number = currentIndex,
): string | null {
  if (accounts.length === 0) return null;
  return accounts[accountIndex]?.authPath ?? null;
}

export function detectCodexRotationTrigger(
  error?: string | null,
): CodexRotationTriggerResult {
  if (!error) return { shouldRotate: false, reason: '' };

  // Common patterns (429, 503, network) — delegated to SSOT
  const common = classifyAgentError(error);
  if (common.category !== 'none') {
    return { shouldRotate: true, reason: common.reason };
  }

  // Codex-specific loose auth check
  const auth = classifyCodexAuthError(error);
  if (auth.category !== 'none') {
    return { shouldRotate: true, reason: auth.reason };
  }

  return { shouldRotate: false, reason: '' };
}

/**
 * Try to rotate to the next available Codex account.
 * Returns true if a fresh account was found.
 */
export function rotateCodexToken(
  errorMessage?: string,
  opts?: { ignoreRateLimits?: boolean },
): boolean {
  if (accounts.length <= 1) return false;

  const previousIndex = currentIndex;
  const acct = accounts[currentIndex];
  const cooldownUntil = computeCooldownUntil(errorMessage);
  acct.rateLimitedUntil = cooldownUntil;
  acct.lastUsagePct = 100;
  // Extract reset time string from error for display
  const retryAt = parseRetryAfterFromError(errorMessage);
  if (retryAt) {
    acct.resetAt = new Date(retryAt).toISOString();
  }

  const nextIdx = findNextAvailable(accounts, currentIndex, opts);
  if (nextIdx !== null) {
    accounts[nextIdx].rateLimitedUntil = null;
    currentIndex = nextIdx;
    logger.info(
      {
        transition: 'rotation:execute',
        fromIndex: previousIndex,
        toIndex: currentIndex,
        totalAccounts: accounts.length,
        accountId: accounts[nextIdx].accountId,
        ignoreRL: opts?.ignoreRateLimits ?? false,
        cooldownUntil:
          cooldownUntil != null ? new Date(cooldownUntil).toISOString() : null,
        reason: errorMessage ?? null,
      },
      `Codex rotated to account #${currentIndex + 1}/${accounts.length}`,
    );
    saveCodexState();
    return true;
  }

  logger.warn(
    {
      transition: 'rotation:skip',
      fromIndex: previousIndex,
      totalAccounts: accounts.length,
      ignoreRL: opts?.ignoreRateLimits ?? false,
      cooldownUntil:
        cooldownUntil != null ? new Date(cooldownUntil).toISOString() : null,
      reason: errorMessage ?? null,
    },
    'All Codex accounts are rate-limited',
  );
  return false;
}

/**
 * Find the next Codex account that is neither rate-limited nor 7d-exhausted.
 */
function findNextCodexAvailable(fromIndex?: number): number | null {
  const now = Date.now();
  const start = fromIndex ?? currentIndex;
  for (let i = 1; i < accounts.length; i++) {
    const idx = (start + i) % accounts.length;
    const acct = accounts[idx];
    const rlOk = !acct.rateLimitedUntil || acct.rateLimitedUntil <= now;
    const usageOk = acct.lastUsageD7Pct == null || acct.lastUsageD7Pct < 100;
    if (rlOk && usageOk) return idx;
  }
  // All exhausted — fall back to rate-limit-only check
  return findNextAvailable(accounts, start);
}

/**
 * Advance to the next healthy account (round-robin).
 * Called after each successful request to spread load evenly
 * and keep usage data fresh for all accounts.
 * Skips accounts with 7d usage ≥ 100% to avoid API billing.
 */
export function advanceCodexAccount(): void {
  if (accounts.length <= 1) return;
  const nextIdx = findNextCodexAvailable();
  if (nextIdx !== null) {
    currentIndex = nextIdx;
    saveCodexState();
  }
  // All others rate-limited/exhausted, stay on current
}

/**
 * Update cached usage info for a specific account (or current if index omitted).
 */
export function updateCodexAccountUsage(
  usagePct: number,
  resetAt?: string,
  accountIndex?: number,
  d7Pct?: number,
  resetD7At?: string,
): void {
  if (accounts.length === 0) return;
  const idx = accountIndex ?? currentIndex;
  const acct = accounts[idx];
  if (acct) {
    acct.lastUsagePct = usagePct;
    if (d7Pct != null) acct.lastUsageD7Pct = d7Pct;
    if (resetAt) acct.resetAt = resetAt;
    if (resetD7At) acct.resetD7At = resetD7At;
    saveCodexState();

    // Auto-rotate away from 7d-exhausted current account to avoid API billing
    if (
      idx === currentIndex &&
      d7Pct != null &&
      d7Pct >= 100 &&
      accounts.length > 1
    ) {
      const nextIdx = findNextCodexAvailable(idx);
      if (nextIdx !== null && nextIdx !== idx) {
        logger.info(
          {
            transition: 'rotation:auto',
            fromIndex: idx,
            toIndex: nextIdx,
            d7Pct,
            accountId: acct.accountId,
          },
          `Codex auto-rotating: account #${idx + 1} at ${d7Pct}% 7d → #${nextIdx + 1}`,
        );
        currentIndex = nextIdx;
        saveCodexState();
      }
    }
  }
}

export function markCodexTokenHealthy(): void {
  if (accounts.length === 0) return;
  const acct = accounts[currentIndex];
  if (acct?.rateLimitedUntil) {
    const previousCooldownUntil = acct.rateLimitedUntil;
    acct.rateLimitedUntil = null;
    logger.info(
      {
        transition: 'rotation:clear-rate-limit',
        accountIndex: currentIndex,
        accountId: acct.accountId,
        cooldownUntil: new Date(previousCooldownUntil).toISOString(),
      },
      'Cleared Codex account rate-limit state after successful response',
    );
    saveCodexState();
  }
}

export function getCodexAccountCount(): number {
  return accounts.length;
}

export function getAllCodexAccounts(): {
  index: number;
  accountId: string;
  planType: string;
  isActive: boolean;
  isRateLimited: boolean;
  cachedUsagePct?: number;
  cachedUsageD7Pct?: number;
  resetAt?: string;
  resetD7At?: string;
}[] {
  const now = Date.now();
  return accounts.map((a, i) => ({
    index: i,
    accountId: a.accountId,
    planType: a.planType,
    isActive: i === currentIndex,
    isRateLimited: Boolean(a.rateLimitedUntil && a.rateLimitedUntil > now),
    cachedUsagePct: a.lastUsagePct,
    cachedUsageD7Pct: a.lastUsageD7Pct,
    resetAt: a.resetAt,
    resetD7At: a.resetD7At,
  }));
}
