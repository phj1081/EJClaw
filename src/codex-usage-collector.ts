import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getAllCodexAccounts,
  getCodexAuthPath,
  updateCodexAccountUsage,
} from './codex-token-rotation.js';
import { readCodexAuthTokens } from './codex-token-rotation-auth-file.js';
import {
  normalizeCodexLiveStatus,
  toCodexLiveStatusSummary,
  type CodexRateLimitWindowSummary,
} from './codex-live-status.js';
import { formatResetRemaining, type UsageRow } from './dashboard-usage-rows.js';
import { logger } from './logger.js';
import { fetchWithTimeout } from './utils.js';

export interface CodexRateLimit {
  limitId?: string;
  limitName: string | null;
  primary: { usedPercent: number; resetsAt: string | number };
  secondary: { usedPercent: number; resetsAt: string | number };
}

export interface CodexWhamUsageResult {
  rateLimits: CodexRateLimit[];
  checkedAt: string;
  limitReached: boolean;
  planType: string | null;
}

/**
 * Result returned by the refresh functions.
 * Caller is responsible for persisting into module-level cache.
 */
export interface CodexUsageRefreshResult {
  rows: UsageRow[];
  /** Non-null only when at least one account was successfully fetched. */
  fetchedAt: string | null;
}

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_USAGE_FETCH_TIMEOUT_MS = 10_000;

function getPreferredCodexPathEntries(): string[] {
  const entries = [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  if (process.versions.bun || path.basename(process.execPath) === 'bun') {
    entries.push(path.join(os.homedir(), '.hermes', 'node', 'bin'));
  }
  return [...new Set(entries)];
}

function getCodexHomeForAccount(accountIndex?: number): string | null {
  const authPath = getCodexAuthPath(accountIndex);
  if (!authPath || !fs.existsSync(authPath)) return null;
  return path.dirname(authPath);
}

function windowResetAt(
  window: CodexRateLimitWindowSummary,
  checkedAt: string,
): string {
  if (window.resetAt) return window.resetAt;
  if (
    window.resetAfterSeconds != null &&
    Number.isFinite(window.resetAfterSeconds)
  ) {
    return new Date(
      new Date(checkedAt).getTime() + window.resetAfterSeconds * 1000,
    ).toISOString();
  }
  return '';
}

function mapWhamWindow(
  window: CodexRateLimitWindowSummary | null,
  checkedAt: string,
): CodexRateLimit['primary'] | null {
  if (!window || window.usedPercent == null) return null;
  return {
    usedPercent: window.usedPercent,
    resetsAt: windowResetAt(window, checkedAt),
  };
}

export async function fetchCodexWhamUsage(
  authPath: string,
): Promise<CodexWhamUsageResult | null> {
  const authTokens = readCodexAuthTokens(authPath);
  if (!authTokens) return null;

  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${authTokens.accessToken}`,
    };
    // Scope the query to the workspace Codex actually uses. Multi-workspace
    // tokens (team plans) may otherwise return another workspace's limits.
    if (authTokens.accountId) {
      headers['chatgpt-account-id'] = authTokens.accountId;
    }
    const response = await fetchWithTimeout(
      CODEX_USAGE_URL,
      {
        method: 'GET',
        headers,
      },
      CODEX_USAGE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return null;

    const checkedAt = new Date().toISOString();
    const normalized = normalizeCodexLiveStatus(
      (await response.json()) as unknown,
      checkedAt,
    );
    if (!normalized) return null;

    const summary = toCodexLiveStatusSummary(normalized);
    const primary = mapWhamWindow(
      summary.rateLimit?.primaryWindow ?? null,
      checkedAt,
    );
    if (!primary) return null;
    const secondary = mapWhamWindow(
      summary.rateLimit?.secondaryWindow ?? null,
      checkedAt,
    ) ?? {
      usedPercent: -1,
      resetsAt: '',
    };

    return {
      rateLimits: [
        {
          limitId: 'codex',
          limitName: 'Codex',
          primary,
          secondary,
        },
      ],
      checkedAt,
      limitReached: summary.rateLimit?.limitReached === true,
      planType: summary.planType,
    };
  } catch {
    return null;
  }
}

export async function fetchCodexUsage(
  codexHomeOverride?: string,
): Promise<CodexRateLimit[] | null> {
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const codexBin = fs.existsSync(npmGlobalBin) ? npmGlobalBin : 'codex';

  return new Promise((resolve) => {
    let done = false;
    let proc: ChildProcess | null = null;
    const finish = (value: CodexRateLimit[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (proc) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), 20_000);

    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: [...getPreferredCodexPathEntries(), process.env.PATH || '']
        .filter(Boolean)
        .join(path.delimiter),
    };
    if (codexHomeOverride) {
      spawnEnv.CODEX_HOME = codexHomeOverride;
    }

    try {
      proc = spawn(codexBin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
      });
    } catch {
      resolve(null);
      return;
    }

    if (!proc.stdout || !proc.stdin) {
      finish(null);
      return;
    }

    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));

    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            proc!.stdin!.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {},
              }) + '\n',
            );
          } else if (message.id === 2 && message.result) {
            const byId = message.result.rateLimitsByLimitId;
            finish(
              byId && typeof byId === 'object'
                ? Object.entries(byId).map(([id, val]) => ({
                    ...(val as CodexRateLimit),
                    limitId: id,
                  }))
                : null,
            );
          }
        } catch {
          /* ignore */
        }
      }
    });

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'usage-monitor', version: '1.0' } },
      }) + '\n',
    );
  });
}

/**
 * Extract usage percentages from the primary 'codex' rate-limit bucket
 * and update the rotation state for a given account.
 *
 * Bucket selection:
 *  1. limitId === 'codex' → use it
 *  2. No 'codex' bucket + single bucket → use it
 *  3. No 'codex' bucket + multiple buckets → unknown (show —)
 *
 * All buckets are logged at info level for observability.
 */
export function applyCodexUsageToAccount(
  usage: CodexRateLimit[],
  accountIndex: number,
  metadata?: {
    fetchedAt?: string;
    limitReached?: boolean;
    planType?: string | null;
  },
): void {
  if (usage.length === 0) return;

  // Log all buckets for observability
  logger.info(
    {
      account: accountIndex + 1,
      buckets: usage.map((l) => ({
        id: l.limitId,
        h5: l.primary.usedPercent,
        d7: l.secondary.usedPercent,
      })),
    },
    `Codex account #${accountIndex + 1}: ${usage.length} rate-limit bucket(s)`,
  );

  // Select the effective bucket
  const primaryBucket = usage.find((l) => l.limitId === 'codex');
  const effective = primaryBucket ?? (usage.length === 1 ? usage[0] : null);

  if (!effective) {
    // Multiple unknown buckets — cannot determine which is authoritative
    logger.warn(
      { account: accountIndex + 1 },
      `Codex account #${accountIndex + 1}: no 'codex' bucket found among ${usage.length} buckets, showing unknown`,
    );
    updateCodexAccountUsage(
      -1,
      undefined,
      accountIndex,
      -1,
      undefined,
      metadata,
    );
    return;
  }

  const pct = Math.round(effective.primary.usedPercent);
  const d7Pct = Math.round(effective.secondary.usedPercent);
  const resetStr = effective.primary.resetsAt
    ? formatResetRemaining(effective.primary.resetsAt)
    : undefined;
  const resetD7Str = effective.secondary.resetsAt
    ? formatResetRemaining(effective.secondary.resetsAt)
    : undefined;
  updateCodexAccountUsage(pct, resetStr, accountIndex, d7Pct, resetD7Str, {
    ...metadata,
    limitReached: metadata?.limitReached ?? pct >= 100,
  });
  logger.info(
    {
      account: accountIndex + 1,
      bucket: effective.limitId,
      h5: pct,
      d7: d7Pct,
      reset: resetStr,
    },
    `Codex account #${accountIndex + 1} usage: 5h=${pct}% 7d=${d7Pct}%`,
  );
}

/**
 * Build display-ready usage rows from Codex rotation state.
 * Called after refreshing usage data.
 */
export function buildCodexUsageRowsFromState(): UsageRow[] {
  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length === 0) return [];

  const isMulti = codexAccounts.length > 1;
  return codexAccounts.map((acct) => {
    const icon = acct.isActive ? '*' : acct.isRateLimited ? '!' : ' ';
    const label = isMulti
      ? `Codex${acct.index + 1}${icon} ${acct.planType}`
      : 'Codex';
    return {
      name: label,
      h5pct: acct.cachedUsagePct != null ? acct.cachedUsagePct : -1,
      h5reset: acct.resetAt || '',
      d7pct: acct.cachedUsageD7Pct != null ? acct.cachedUsageD7Pct : -1,
      d7reset: acct.resetD7At || '',
      fetchedAt: acct.lastUsageFetchedAt,
      limitReached: acct.usageLimitReached,
    };
  });
}

async function refreshCodexAccountUsage(
  accountIndex: number,
): Promise<string | null> {
  const authPath = getCodexAuthPath(accountIndex);
  if (!authPath) return null;

  const live = await fetchCodexWhamUsage(authPath);
  if (live) {
    applyCodexUsageToAccount(live.rateLimits, accountIndex, {
      fetchedAt: live.checkedAt,
      limitReached: live.limitReached,
      planType: live.planType,
    });
    return live.checkedAt;
  }

  logger.warn(
    { account: accountIndex + 1 },
    'Direct Codex usage fetch failed; falling back to app-server',
  );

  const accountDir = getCodexHomeForAccount(accountIndex);
  if (!accountDir) return null;
  const usage = await fetchCodexUsage(accountDir);
  if (!usage || !Array.isArray(usage) || usage.length === 0) return null;

  const fetchedAt = new Date().toISOString();
  applyCodexUsageToAccount(usage, accountIndex, { fetchedAt });
  return fetchedAt;
}

/**
 * Refresh ALL Codex accounts, preferring direct wham/usage HTTP.
 * Returns refresh result — caller owns cache state.
 */
let refreshAllInFlight = false;

export async function refreshAllCodexAccountUsage(): Promise<CodexUsageRefreshResult> {
  if (refreshAllInFlight) {
    // Overlapping call (5-min interval vs post-warmup refresh) — serve cached
    // state instead of double-fetching every account.
    return { rows: buildCodexUsageRowsFromState(), fetchedAt: null };
  }
  refreshAllInFlight = true;
  try {
    return await refreshAllCodexAccountUsageInner();
  } finally {
    refreshAllInFlight = false;
  }
}

async function refreshAllCodexAccountUsageInner(): Promise<CodexUsageRefreshResult> {
  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length === 0) return { rows: [], fetchedAt: null };

  logger.info(
    { accountCount: codexAccounts.length },
    'Refreshing all Codex accounts for usage data',
  );

  let latestFetchedAt: string | null = null;
  for (const acct of codexAccounts) {
    try {
      const fetchedAt = await refreshCodexAccountUsage(acct.index);
      if (fetchedAt && (!latestFetchedAt || fetchedAt > latestFetchedAt)) {
        latestFetchedAt = fetchedAt;
      }
    } catch (err) {
      logger.debug(
        { err, account: acct.index + 1 },
        'Failed to fetch usage for Codex account',
      );
    }
  }

  return {
    rows: buildCodexUsageRowsFromState(),
    fetchedAt: latestFetchedAt,
  };
}

/**
 * Quick-refresh the active Codex account's usage.
 * Returns refresh result — caller owns cache state.
 */
export async function refreshActiveCodexUsage(): Promise<CodexUsageRefreshResult> {
  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length === 0) {
    return { rows: [], fetchedAt: null };
  }

  const active = codexAccounts.find((a) => a.isActive);
  if (!active) {
    return { rows: buildCodexUsageRowsFromState(), fetchedAt: null };
  }

  let fetchedAt: string | null = null;
  try {
    fetchedAt = await refreshCodexAccountUsage(active.index);
  } catch (err) {
    logger.debug({ err }, 'Failed to fetch active Codex account usage');
  }

  return { rows: buildCodexUsageRowsFromState(), fetchedAt };
}
