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

import { logger } from './logger.js';

interface CodexAccount {
  index: number;
  authPath: string;
  accountId: string;
  rateLimitedUntil: number | null;
}

const accounts: CodexAccount[] = [];
let currentIndex = 0;
let initialized = false;

const ACCOUNTS_DIR = path.join(os.homedir(), '.codex-accounts');

export function initCodexTokenRotation(): void {
  if (initialized) return;
  initialized = true;

  if (!fs.existsSync(ACCOUNTS_DIR)) {
    logger.info({ dir: ACCOUNTS_DIR }, 'Codex accounts dir not found, skipping');
    return;
  }

  const dirs = fs.readdirSync(ACCOUNTS_DIR)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => parseInt(a) - parseInt(b));

  for (const dir of dirs) {
    const authPath = path.join(ACCOUNTS_DIR, dir, 'auth.json');
    if (!fs.existsSync(authPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      const accountId = data?.tokens?.account_id || `account-${dir}`;
      accounts.push({
        index: accounts.length,
        authPath,
        accountId,
        rateLimitedUntil: null,
      });
    } catch {
      logger.warn({ authPath }, 'Failed to parse codex account auth.json');
    }
  }

  logger.info(
    { count: accounts.length, dir: ACCOUNTS_DIR },
    `Codex token rotation: ${accounts.length} account(s) found`,
  );
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
export function rotateCodexToken(): boolean {
  if (accounts.length <= 1) return false;

  const now = Date.now();
  accounts[currentIndex].rateLimitedUntil = now + 3_600_000;

  for (let i = 1; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length;
    const acct = accounts[idx];
    if (!acct.rateLimitedUntil || acct.rateLimitedUntil <= now) {
      acct.rateLimitedUntil = null;
      currentIndex = idx;
      logger.info(
        { accountIndex: currentIndex, totalAccounts: accounts.length, accountId: acct.accountId },
        `Codex rotated to account #${currentIndex + 1}/${accounts.length}`,
      );
      return true;
    }
  }

  logger.warn('All Codex accounts are rate-limited');
  return false;
}

export function markCodexTokenHealthy(): void {
  if (accounts.length === 0) return;
  const acct = accounts[currentIndex];
  if (acct?.rateLimitedUntil) {
    acct.rateLimitedUntil = null;
  }
}

export function getCodexAccountCount(): number {
  return accounts.length;
}

export function getAllCodexAccounts(): {
  index: number;
  accountId: string;
  isActive: boolean;
  isRateLimited: boolean;
}[] {
  const now = Date.now();
  return accounts.map((a, i) => ({
    index: i,
    accountId: a.accountId,
    isActive: i === currentIndex,
    isRateLimited: Boolean(a.rateLimitedUntil && a.rateLimitedUntil > now),
  }));
}
