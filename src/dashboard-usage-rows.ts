import { getClaudeProfile, type ClaudeAccountUsage } from './claude-usage.js';
import type { StatusSnapshot } from './status-dashboard.js';

export type UsageRow = {
  name: string;
  h5pct: number;
  h5reset: string;
  d7pct: number;
  d7reset: string;
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
      h5pct: h5
        ? h5.utilization > 1
          ? Math.round(h5.utilization)
          : Math.round(h5.utilization * 100)
        : -1,
      h5reset: h5 ? formatResetRemaining(h5.resets_at) : '',
      d7pct: d7
        ? d7.utilization > 1
          ? Math.round(d7.utilization)
          : Math.round(d7.utilization * 100)
        : -1,
      d7reset: d7 ? formatResetRemaining(d7.resets_at) : '',
    };
  });
}

/**
 * Extract Codex usage rows from a snapshot, applying staleness check.
 * Returns real rows if usageRowsFetchedAt is within maxAgeMs, otherwise a
 * single degraded row. Returns empty array if no usage data present.
 */
export function extractCodexUsageRows(
  snapshot: StatusSnapshot | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): UsageRow[] {
  if (!snapshot?.usageRows || snapshot.usageRows.length === 0) return [];

  const fetchedAt = snapshot.usageRowsFetchedAt
    ? new Date(snapshot.usageRowsFetchedAt).getTime()
    : 0;
  const usageAge = now - fetchedAt;
  if (usageAge <= maxAgeMs) {
    return [...snapshot.usageRows];
  }
  // Usage data is stale — return degraded indicator
  return [{ name: 'Codex', h5pct: -1, h5reset: '', d7pct: -1, d7reset: '' }];
}
