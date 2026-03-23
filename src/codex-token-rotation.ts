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

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

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

export function initCodexTokenRotation(): void {
  if (initialized) return;
  initialized = true;

  if (!fs.existsSync(ACCOUNTS_DIR)) {
    logger.info(
      { dir: ACCOUNTS_DIR },
      'Codex accounts dir not found, skipping',
    );
    return;
  }

  const dirs = fs
    .readdirSync(ACCOUNTS_DIR)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => parseInt(a) - parseInt(b));

  for (const dir of dirs) {
    const authPath = path.join(ACCOUNTS_DIR, dir, 'auth.json');
    if (!fs.existsSync(authPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      const accountId = data?.tokens?.account_id || `account-${dir}`;
      const jwt = parseJwtAuth(data?.tokens?.id_token || '');
      const planType = jwt.planType;
      accounts.push({
        index: accounts.length,
        authPath,
        accountId,
        planType,
        subscriptionUntil: jwt.expiresAt,
        rateLimitedUntil: null,
      });
    } catch {
      logger.warn({ authPath }, 'Failed to parse codex account auth.json');
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
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

function loadCodexState(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
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
        }
      }
    }
    if (Array.isArray(state.usagePcts)) {
      for (
        let i = 0;
        i < Math.min(state.usagePcts.length, accounts.length);
        i++
      ) {
        if (typeof state.usagePcts[i] === 'number')
          accounts[i].lastUsagePct = state.usagePcts[i];
      }
    }
    if (Array.isArray(state.usageD7Pcts)) {
      for (
        let i = 0;
        i < Math.min(state.usageD7Pcts.length, accounts.length);
        i++
      ) {
        if (typeof state.usageD7Pcts[i] === 'number')
          accounts[i].lastUsageD7Pct = state.usageD7Pcts[i];
      }
    }
    if (Array.isArray(state.resetAts)) {
      for (
        let i = 0;
        i < Math.min(state.resetAts.length, accounts.length);
        i++
      ) {
        if (state.resetAts[i]) accounts[i].resetAt = state.resetAts[i];
      }
    }
    if (Array.isArray(state.resetD7Ats)) {
      for (
        let i = 0;
        i < Math.min(state.resetD7Ats.length, accounts.length);
        i++
      ) {
        if (state.resetD7Ats[i]) accounts[i].resetD7At = state.resetD7Ats[i];
      }
    }
    logger.info(
      { currentIndex, accountCount: accounts.length },
      'Codex rotation state restored',
    );
  } catch {
    /* start fresh */
  }
}

const BUFFER_MS = 3 * 60_000; // 3 min buffer after reset time
const DEFAULT_COOLDOWN_MS = 3_600_000; // 1 hour fallback

/**
 * Parse "try again at Mar 26th, 2026 9:00 AM" from error message.
 * Returns timestamp in ms, or null if not found.
 */
function parseRetryAfterFromError(error?: string): number | null {
  if (!error) return null;
  const match = error.match(
    /try again at\s+(\w+ \d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  );
  if (!match) return null;
  try {
    // Remove ordinal suffixes (1st, 2nd, 3rd, 4th)
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

/** Get the auth.json path for the current active account. */
export function getActiveCodexAuthPath(): string | null {
  if (accounts.length === 0) return null;
  return accounts[currentIndex]?.authPath ?? null;
}

/**
 * Try to rotate to the next available Codex account.
 * Returns true if a fresh account was found.
 */
export function rotateCodexToken(errorMessage?: string): boolean {
  if (accounts.length <= 1) return false;

  const now = Date.now();
  const acct = accounts[currentIndex];
  acct.rateLimitedUntil = computeCooldownUntil(errorMessage);
  acct.lastUsagePct = 100;
  // Extract reset time string from error for display
  const resetMatch = errorMessage?.match(
    /try again at\s+(\w+ \d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  );
  if (resetMatch) acct.resetAt = resetMatch[1];

  for (let i = 1; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length;
    const acct = accounts[idx];
    if (!acct.rateLimitedUntil || acct.rateLimitedUntil <= now) {
      acct.rateLimitedUntil = null;
      currentIndex = idx;
      logger.info(
        {
          accountIndex: currentIndex,
          totalAccounts: accounts.length,
          accountId: acct.accountId,
        },
        `Codex rotated to account #${currentIndex + 1}/${accounts.length}`,
      );
      saveCodexState();
      return true;
    }
  }

  logger.warn('All Codex accounts are rate-limited');
  return false;
}

/**
 * Advance to the next healthy account (round-robin).
 * Called after each successful request to spread load evenly
 * and keep usage data fresh for all accounts.
 */
export function advanceCodexAccount(): void {
  if (accounts.length <= 1) return;
  const now = Date.now();
  for (let i = 1; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length;
    const acct = accounts[idx];
    if (!acct.rateLimitedUntil || acct.rateLimitedUntil <= now) {
      currentIndex = idx;
      saveCodexState();
      return;
    }
  }
  // All others rate-limited, stay on current
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
  }
}

export function markCodexTokenHealthy(): void {
  if (accounts.length === 0) return;
  const acct = accounts[currentIndex];
  if (acct?.rateLimitedUntil) {
    acct.rateLimitedUntil = null;
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
