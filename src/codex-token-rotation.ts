import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CodexAccountState {
  index: number;
  planType: string;
  isActive: boolean;
  isRateLimited: boolean;
  cachedUsagePct?: number;
  resetAt?: string;
  cachedUsageD7Pct?: number;
  resetD7At?: string;
}

const HOST_CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_ACCOUNTS_DIR = path.join(os.homedir(), '.codex-accounts');

let activeIndexCache: number | null = null;
const rateLimitedAccounts = new Set<number>();
const usageCache = new Map<
  number,
  {
    cachedUsagePct?: number;
    resetAt?: string;
    cachedUsageD7Pct?: number;
    resetD7At?: string;
  }
>();

function listCodexAccountDirs(): string[] {
  if (!fs.existsSync(CODEX_ACCOUNTS_DIR)) return [];

  return fs
    .readdirSync(CODEX_ACCOUNTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .sort((a, b) => Number(a.name) - Number(b.name))
    .map((entry) => path.join(CODEX_ACCOUNTS_DIR, entry.name));
}

function readTextIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function inferPlanType(accountDir: string): string {
  try {
    const authPath = path.join(accountDir, 'auth.json');
    if (!fs.existsSync(authPath)) return 'API';
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as {
      auth_mode?: string;
    };
    if (!raw.auth_mode) return 'API';
    return raw.auth_mode
      .split(/[_-]/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ');
  } catch {
    return 'API';
  }
}

function resolveActiveIndex(accountDirs: string[]): number {
  if (accountDirs.length <= 1) return 0;
  if (activeIndexCache !== null && activeIndexCache < accountDirs.length) {
    return activeIndexCache;
  }

  const hostAuth = readTextIfExists(path.join(HOST_CODEX_DIR, 'auth.json'));
  if (hostAuth) {
    const matchIndex = accountDirs.findIndex(
      (accountDir) => readTextIfExists(path.join(accountDir, 'auth.json')) === hostAuth,
    );
    if (matchIndex >= 0) {
      activeIndexCache = matchIndex;
      return matchIndex;
    }
  }

  activeIndexCache = 0;
  return 0;
}

function copyIfExists(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function syncHostCodexAccount(accountDir: string): void {
  copyIfExists(path.join(accountDir, 'auth.json'), path.join(HOST_CODEX_DIR, 'auth.json'));
}

export function getAllCodexAccounts(): CodexAccountState[] {
  const accountDirs = listCodexAccountDirs();
  if (accountDirs.length === 0) {
    return [
      {
        index: 0,
        planType: 'API',
        isActive: true,
        isRateLimited: false,
      },
    ];
  }

  const activeIndex = resolveActiveIndex(accountDirs);
  return accountDirs.map((accountDir, index) => ({
    index,
    planType: inferPlanType(accountDir),
    isActive: index === activeIndex,
    isRateLimited: rateLimitedAccounts.has(index),
    ...usageCache.get(index),
  }));
}

export function getCodexAccountCount(): number {
  return getAllCodexAccounts().length;
}

export function rotateCodexToken(_reason?: string): boolean {
  const accountDirs = listCodexAccountDirs();
  if (accountDirs.length <= 1) return false;

  const activeIndex = resolveActiveIndex(accountDirs);
  rateLimitedAccounts.add(activeIndex);

  const candidates = accountDirs.map((_, index) => index);
  const nextIndex =
    candidates.find(
      (index) => index !== activeIndex && !rateLimitedAccounts.has(index),
    ) ??
    candidates.find((index) => index !== activeIndex);

  if (nextIndex === undefined) return false;

  syncHostCodexAccount(accountDirs[nextIndex]);
  activeIndexCache = nextIndex;
  return true;
}

export function markCodexTokenHealthy(): void {
  const accountDirs = listCodexAccountDirs();
  const activeIndex = resolveActiveIndex(accountDirs);
  rateLimitedAccounts.delete(activeIndex);
}

export function updateCodexAccountUsage(
  pct: number,
  resetAt: string | undefined,
  index: number,
  d7Pct?: number,
  resetD7At?: string,
): void {
  usageCache.set(index, {
    cachedUsagePct: pct,
    resetAt,
    cachedUsageD7Pct: d7Pct,
    resetD7At,
  });
}
