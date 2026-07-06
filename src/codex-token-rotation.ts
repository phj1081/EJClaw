/**
 * Codex OAuth Token Rotation
 *
 * Rotates between multiple Codex (ChatGPT) OAuth accounts when
 * rate-limited. Each account is stored as an isolated CODEX_HOME under
 * ~/.codex-accounts/{n}/, with auth.json/config.toml in that directory.
 *
 * For pooled accounts EJClaw leases the account directory directly and passes
 * it as CODEX_HOME. Do not copy auth.json into session directories: Codex
 * OAuth refresh tokens are rotating credentials, so stale copies can consume
 * or overwrite each other and permanently poison a slot.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  classifyAgentError,
  classifyCodexAuthError,
  isCodexPoolUnavailableError,
  type CodexRotationReason,
} from './agent-error-detection.js';
import {
  parseJwtAuth,
  readAuthFileMtimeMs,
} from './codex-token-rotation-auth-file.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  computeCooldownUntil,
  parseRetryAfterFromError,
} from './token-rotation-base.js';
import { readJsonFile, writeJsonFile } from './utils.js';

const STATE_FILE = path.join(DATA_DIR, 'codex-rotation-state.json');

interface CodexAccount {
  index: number;
  authPath: string;
  accountId: string;
  authFileMtimeMs: number;
  planType: string;
  subscriptionUntil: string | null;
  rateLimitedUntil: number | null;
  authStatus: 'healthy' | 'dead_auth';
  authDeadAt: number | null;
  authDeadReason: string | null;
  leasedUntil: number | null;
  leaseId: string | null;
  lastUsagePct?: number;
  lastUsageD7Pct?: number;
  resetAt?: string;
  resetD7At?: string;
}

export interface CodexAuthLease {
  accountIndex: number;
  authPath: string;
  release: () => void;
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

const accounts: CodexAccount[] = [];
let currentIndex = 0;
let initialized = false;

const CODEX_AUTH_LEASE_MS = 2 * 60 * 60_000;

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
    authFileMtimeMs: readAuthFileMtimeMs(authPath),
    planType: jwt.planType,
    subscriptionUntil: jwt.expiresAt,
    rateLimitedUntil: null,
    authStatus: 'healthy',
    authDeadAt: null,
    authDeadReason: null,
    leasedUntil: null,
    leaseId: null,
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
      authDeadAts: accounts.map((a) => a.authDeadAt),
      authDeadReasons: accounts.map((a) => a.authDeadReason),
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
    authDeadAts?: (number | null)[];
    authDeadReasons?: (string | null)[];
    usagePcts?: (number | null)[];
    usageD7Pcts?: (number | null)[];
    resetAts?: (string | null)[];
    resetD7Ats?: (string | null)[];
  }>(STATE_FILE);
  if (!state) return;

  const now = Date.now();
  let restoredDeadAuth = false;
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
  if (Array.isArray(state.authDeadAts)) {
    for (
      let i = 0;
      i < Math.min(state.authDeadAts.length, accounts.length);
      i++
    ) {
      const deadAt = state.authDeadAts[i];
      const acct = accounts[i];
      if (typeof deadAt === 'number' && deadAt > 0) {
        const currentMtime = readAuthFileMtimeMs(acct.authPath);
        acct.authFileMtimeMs = currentMtime;
        if (currentMtime > deadAt) {
          acct.authStatus = 'dead_auth';
          acct.authDeadAt = deadAt;
          acct.authDeadReason = state.authDeadReasons?.[i] ?? 'auth-expired';
          restoredDeadAuth =
            restoreDeadAuthIfAuthFileChanged(acct) || restoredDeadAuth;
        } else {
          acct.authStatus = 'dead_auth';
          acct.authDeadAt = deadAt;
          acct.authDeadReason = state.authDeadReasons?.[i] ?? 'auth-expired';
          acct.rateLimitedUntil = null;
        }
      }
    }
  }
  if (
    currentIndex < accounts.length &&
    accounts[currentIndex]?.authStatus === 'dead_auth'
  ) {
    const nextIdx = findNextCodexAvailable(currentIndex);
    if (nextIdx !== null) currentIndex = nextIdx;
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
  if (restoredDeadAuth) saveCodexState();
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

function codexLockPath(authPath: string): string {
  return path.join(path.dirname(authPath), '.ejclaw-auth.lock');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readExistingLease(lockPath: string): {
  leaseId?: string;
  pid?: number;
  expiresAt?: number;
} | null {
  const data = readJsonFile<{
    leaseId?: string;
    pid?: number;
    expiresAt?: number;
  }>(lockPath);
  return data ?? null;
}

function tryAcquireDiskLease(
  acct: CodexAccount,
  leaseId: string,
  now: number,
): boolean {
  const lockPath = codexLockPath(acct.authPath);
  const payload = JSON.stringify(
    {
      leaseId,
      pid: process.pid,
      accountIndex: acct.index,
      createdAt: now,
      expiresAt: now + CODEX_AUTH_LEASE_MS,
    },
    null,
    2,
  );

  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }

  const existing = readExistingLease(lockPath);
  const expired = Boolean(existing?.expiresAt && existing.expiresAt <= now);
  const deadPid = Boolean(existing?.pid && !isPidAlive(existing.pid));
  if (!expired && !deadPid) return false;

  try {
    fs.unlinkSync(lockPath);
  } catch {
    return false;
  }

  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseDiskLease(authPath: string, leaseId: string): void {
  const lockPath = codexLockPath(authPath);
  const existing = readExistingLease(lockPath);
  if (existing?.leaseId && existing.leaseId !== leaseId) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Best effort only. Expired/stale locks are cleared by the next claimant.
  }
}

function isCodexAccountUsable(
  acct: CodexAccount,
  now = Date.now(),
  opts?: { ignoreRateLimits?: boolean; ignoreD7?: boolean },
): boolean {
  if (restoreDeadAuthIfAuthFileChanged(acct)) saveCodexState();
  if (acct.authStatus === 'dead_auth') return false;
  if (
    !opts?.ignoreRateLimits &&
    acct.rateLimitedUntil &&
    acct.rateLimitedUntil > now
  ) {
    return false;
  }
  if (
    !opts?.ignoreD7 &&
    acct.lastUsageD7Pct != null &&
    acct.lastUsageD7Pct >= 100
  ) {
    return false;
  }
  if (acct.leasedUntil && acct.leasedUntil > now) return false;

  const existing = readExistingLease(codexLockPath(acct.authPath));
  if (!existing) return true;
  if (existing.expiresAt && existing.expiresAt <= now) return true;
  if (existing.pid && !isPidAlive(existing.pid)) return true;
  return false;
}

function restoreDeadAuthIfAuthFileChanged(acct: CodexAccount): boolean {
  if (acct.authStatus !== 'dead_auth' || !acct.authDeadAt) return false;
  const currentMtime = readAuthFileMtimeMs(acct.authPath);
  acct.authFileMtimeMs = currentMtime;
  if (currentMtime <= acct.authDeadAt) return false;

  const previousDeadAt = acct.authDeadAt;
  acct.authStatus = 'healthy';
  acct.authDeadAt = null;
  acct.authDeadReason = null;
  acct.rateLimitedUntil = null;
  logger.info(
    {
      transition: 'rotation:auth-file-refreshed',
      accountIndex: acct.index,
      previousDeadAt: new Date(previousDeadAt).toISOString(),
      authFileMtime: new Date(currentMtime).toISOString(),
    },
    `Codex account #${acct.index + 1}/${accounts.length} marked healthy after auth.json refresh`,
  );
  return true;
}

function markCodexAccountDeadAuth(acct: CodexAccount, reason?: string): void {
  acct.authStatus = 'dead_auth';
  acct.authDeadAt = Date.now();
  acct.authDeadReason = reason || 'auth-expired';
  acct.rateLimitedUntil = null;
  acct.leasedUntil = null;
  acct.leaseId = null;
  logger.warn(
    {
      transition: 'rotation:dead-auth',
      accountIndex: acct.index,
      accountId: acct.accountId,
      reason: acct.authDeadReason,
    },
    `Codex account #${acct.index + 1}/${accounts.length} marked dead; re-auth required`,
  );
}

function updateAccountMetadataFromAuthFile(acct: CodexAccount): void {
  const data = readJsonFile<{
    tokens?: { account_id?: string; id_token?: string };
  }>(acct.authPath);
  if (data?.tokens?.account_id) acct.accountId = data.tokens.account_id;
  const jwt = parseJwtAuth(data?.tokens?.id_token || '');
  acct.planType = jwt.planType;
  acct.subscriptionUntil = jwt.expiresAt;
  acct.authFileMtimeMs = readAuthFileMtimeMs(acct.authPath);
}

export function claimCodexAuthLease(): CodexAuthLease | null {
  if (accounts.length === 0) return null;
  const now = Date.now();
  const attempts = accounts.length;
  for (let offset = 0; offset < attempts; offset += 1) {
    const idx = (currentIndex + offset) % accounts.length;
    const acct = accounts[idx];
    if (!isCodexAccountUsable(acct, now)) continue;
    const leaseId = `${process.pid}-${now}-${idx}-${Math.random()
      .toString(36)
      .slice(2)}`;
    if (!tryAcquireDiskLease(acct, leaseId, now)) continue;
    currentIndex = idx;
    acct.leasedUntil = now + CODEX_AUTH_LEASE_MS;
    acct.leaseId = leaseId;
    return {
      accountIndex: idx,
      authPath: acct.authPath,
      release: () => {
        if (acct.leaseId === leaseId) {
          acct.leasedUntil = null;
          acct.leaseId = null;
        }
        releaseDiskLease(acct.authPath, leaseId);
      },
    };
  }
  return null;
}

export function syncCodexSessionAuthBack(args: {
  canonicalAuthPath: string;
  sessionAuthPath: string;
  accountIndex?: number | null;
}): boolean {
  if (!fs.existsSync(args.sessionAuthPath)) return false;
  if (!fs.existsSync(args.canonicalAuthPath)) return false;

  const idx =
    args.accountIndex ??
    findCodexAccountIndexByAuthPath(args.canonicalAuthPath);
  if (
    path.resolve(args.sessionAuthPath) === path.resolve(args.canonicalAuthPath)
  ) {
    if (idx != null && accounts[idx]) {
      updateAccountMetadataFromAuthFile(accounts[idx]);
    }
    return false;
  }

  const canonical = readJsonFile<{
    auth_mode?: string;
    tokens?: { account_id?: string };
  }>(args.canonicalAuthPath);
  const session = readJsonFile<{
    auth_mode?: string;
    tokens?: { account_id?: string };
  }>(args.sessionAuthPath);
  if (!canonical || !session?.tokens) return false;

  const canonicalAccount = canonical.tokens?.account_id;
  const sessionAccount = session.tokens.account_id;
  if (
    canonicalAccount &&
    sessionAccount &&
    canonicalAccount !== sessionAccount
  ) {
    logger.warn(
      {
        canonicalAuthPath: args.canonicalAuthPath,
        sessionAuthPath: args.sessionAuthPath,
        accountIndex: args.accountIndex ?? null,
      },
      'Refusing to sync Codex session auth back: account mismatch',
    );
    return false;
  }

  const sessionRaw = fs.readFileSync(args.sessionAuthPath, 'utf-8');
  const canonicalRaw = fs.readFileSync(args.canonicalAuthPath, 'utf-8');
  if (sessionRaw === canonicalRaw) return false;

  const tmpPath = `${args.canonicalAuthPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, sessionRaw, { mode: 0o600 });
  fs.renameSync(tmpPath, args.canonicalAuthPath);

  if (idx != null && accounts[idx]) {
    const acct = accounts[idx];
    acct.authStatus = 'healthy';
    acct.authDeadAt = null;
    acct.authDeadReason = null;
    updateAccountMetadataFromAuthFile(acct);
    saveCodexState();
  }

  logger.info(
    {
      accountIndex: idx,
      canonicalAuthPath: args.canonicalAuthPath,
    },
    'Synced refreshed Codex session auth back to canonical account slot',
  );
  return true;
}

export function detectCodexRotationTrigger(
  error?: string | null,
): CodexRotationTriggerResult {
  if (!error) return { shouldRotate: false, reason: '' };
  if (isCodexPoolUnavailableError(error)) {
    return { shouldRotate: false, reason: '' };
  }

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

  if (isCodexPoolUnavailableError(errorMessage)) {
    logger.warn(
      {
        transition: 'rotation:skip-pool-unavailable-sentinel',
        currentIndex,
        totalAccounts: accounts.length,
        reason: errorMessage ?? null,
      },
      'Refusing to mark Codex accounts unhealthy from internal pool-unavailable sentinel',
    );
    return false;
  }

  const previousIndex = currentIndex;
  const acct = accounts[currentIndex];
  const authFailure = classifyCodexAuthError(errorMessage);
  let cooldownUntil: number | null = null;

  if (authFailure.category === 'auth-expired') {
    markCodexAccountDeadAuth(acct, errorMessage || authFailure.reason);
  } else {
    cooldownUntil = computeCooldownUntil(errorMessage);
    acct.rateLimitedUntil = cooldownUntil;
    acct.lastUsagePct = 100;
    // Extract reset time string from error for display
    const retryAt = parseRetryAfterFromError(errorMessage);
    if (retryAt) {
      acct.resetAt = new Date(retryAt).toISOString();
    }
  }

  const nextIdx = findNextCodexAvailable(currentIndex, opts);
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
        authDead: authFailure.category === 'auth-expired',
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
      authDead: authFailure.category === 'auth-expired',
      reason: errorMessage ?? null,
    },
    authFailure.category === 'auth-expired'
      ? 'All Codex accounts unavailable after auth failure; re-auth required'
      : 'All Codex accounts are rate-limited',
  );
  saveCodexState();
  return false;
}

/**
 * Find the next Codex account that is neither rate-limited nor 7d-exhausted.
 */
function findNextCodexAvailable(
  fromIndex?: number,
  opts?: { ignoreRateLimits?: boolean },
): number | null {
  const now = Date.now();
  const start = fromIndex ?? currentIndex;
  for (let i = 1; i < accounts.length; i++) {
    const idx = (start + i) % accounts.length;
    const acct = accounts[idx];
    if (isCodexAccountUsable(acct, now, opts)) return idx;
  }
  // All d7-exhausted — fall back to rate-limit/dead/lease checks only.
  for (let i = 1; i < accounts.length; i++) {
    const idx = (start + i) % accounts.length;
    const acct = accounts[idx];
    if (isCodexAccountUsable(acct, now, { ...opts, ignoreD7: true })) {
      return idx;
    }
  }
  return null;
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
  let changed = false;
  if (acct?.authStatus === 'dead_auth') {
    acct.authStatus = 'healthy';
    acct.authDeadAt = null;
    acct.authDeadReason = null;
    changed = true;
  }
  if (acct?.rateLimitedUntil) {
    const previousCooldownUntil = acct.rateLimitedUntil;
    acct.rateLimitedUntil = null;
    changed = true;
    logger.info(
      {
        transition: 'rotation:clear-rate-limit',
        accountIndex: currentIndex,
        accountId: acct.accountId,
        cooldownUntil: new Date(previousCooldownUntil).toISOString(),
      },
      'Cleared Codex account rate-limit state after successful response',
    );
  }
  if (changed) saveCodexState();
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
  isAuthDead?: boolean;
  authStatus?: 'healthy' | 'dead_auth';
  authDeadAt?: string;
  isLeased?: boolean;
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
    isAuthDead: a.authStatus === 'dead_auth',
    authStatus: a.authStatus,
    authDeadAt: a.authDeadAt ? new Date(a.authDeadAt).toISOString() : undefined,
    isLeased: Boolean(a.leasedUntil && a.leasedUntil > now),
    cachedUsagePct: a.lastUsagePct,
    cachedUsageD7Pct: a.lastUsageD7Pct,
    resetAt: a.resetAt,
    resetD7At: a.resetD7At,
  }));
}
