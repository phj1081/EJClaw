import { getClaudeProfile, type ClaudeAccountUsage } from './claude-usage.js';
import type { StatusSnapshot } from './status-dashboard.js';

export type UsageRow = {
  name: string;
  h5pct: number;
  h5reset: string;
  d7pct: number;
  d7reset: string;
  fetchedAt?: string;
  limitReached?: boolean;
  staleAgeMinutes?: number;
};

export function formatResetRemaining(value: string | number): string {
  if (value === '' || value == null) return '';
  try {
    const date =
      typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const diffMs = date.getTime() - Date.now();
    if (diffMs <= 0) return ' reset';
    const hours = Math.floor(diffMs / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remH = hours % 24;
      return `${String(days).padStart(2)}d ${String(remH).padStart(2)}h`;
    }
    return `${String(hours).padStart(2)}h ${String(minutes).padStart(2)}m`;
  } catch {
    return String(value).padStart(6);
  }
}

export function mergeClaudeDashboardAccounts(
  liveAccounts: ClaudeAccountUsage[] | null | undefined,
  cachedAccounts: ClaudeAccountUsage[],
): ClaudeAccountUsage[] {
  if (!liveAccounts) return cachedAccounts;

  const cachedByIndex = new Map(
    cachedAccounts.map((account) => [account.index, account]),
  );

  return liveAccounts.map((account) => ({
    ...account,
    usage: account.usage || cachedByIndex.get(account.index)?.usage || null,
  }));
}

export function buildClaudeUsageRows(
  claudeAccounts: ClaudeAccountUsage[],
): UsageRow[] {
  const isMultiAccount = claudeAccounts.length > 1;

  return claudeAccounts.map((account) => {
    const usage = account.usage;
    const h5 = usage?.five_hour;
    const d7 = usage?.seven_day;
    const profile = getClaudeProfile(account.index);
    const planSuffix = profile ? ` ${profile.planType}` : '';
    const label = isMultiAccount
      ? `Claude${account.index + 1}${account.isActive ? '*' : ''}${account.isRateLimited ? '!' : ''}${planSuffix}`
      : `Claude${account.isActive ? '*' : ''}${account.isRateLimited ? '!' : ''}${planSuffix}`;

    return {
      name: label,
      h5pct: h5 ? Math.round(h5.utilization) : -1,
      h5reset: h5 ? formatResetRemaining(h5.resets_at) : '',
      d7pct: d7 ? Math.round(d7.utilization) : -1,
      d7reset: d7 ? formatResetRemaining(d7.resets_at) : '',
    };
  });
}

/**
 * Extract Codex usage rows from a snapshot, applying staleness check.
 * Prefers each row's fetchedAt and falls back to the legacy snapshot timestamp.
 * Returns a degraded row only when usage exists without any fetch timestamp.
 */
export function extractCodexUsageRows(
  snapshot: StatusSnapshot | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): UsageRow[] {
  if (!snapshot?.usageRows || snapshot.usageRows.length === 0) return [];

  const hasFetchTimestamp =
    Boolean(snapshot.usageRowsFetchedAt) ||
    snapshot.usageRows.some((row) => Boolean(row.fetchedAt));
  if (!hasFetchTimestamp) {
    return [{ name: 'Codex', h5pct: -1, h5reset: '', d7pct: -1, d7reset: '' }];
  }

  return markCodexUsageRowsStale(
    snapshot.usageRows,
    maxAgeMs,
    now,
    snapshot.usageRowsFetchedAt,
  );
}

export function markCodexUsageRowsStale(
  rows: UsageRow[],
  maxAgeMs: number,
  now: number = Date.now(),
  fallbackFetchedAt?: string,
): UsageRow[] {
  return rows.map((row) => {
    const { staleAgeMinutes: _previousStaleAge, ...baseRow } = row;
    const rawFetchedAt = row.fetchedAt || fallbackFetchedAt;
    if (!rawFetchedAt) return baseRow;

    const fetchedAt = new Date(rawFetchedAt).getTime();
    const ageMs = now - fetchedAt;
    if (!Number.isFinite(ageMs) || ageMs <= maxAgeMs) return baseRow;

    return {
      ...baseRow,
      staleAgeMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
    };
  });
}
