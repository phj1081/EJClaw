import { useMemo } from 'react';

import type { DashboardOverview } from './api';
import { EmptyState } from './EmptyState';
import type { Messages } from './i18n';

export type UsageRow = DashboardOverview['usage']['rows'][number];

type RiskLevel = 'ok' | 'warn' | 'critical';
type UsageGroup = 'primary' | 'codex';
type UsageLimitWindow = 'h5' | 'd7';

export interface UsagePanelProps {
  overview: DashboardOverview;
  t: Messages;
}

function formatPct(value: number): string {
  if (value < 0) return '-';
  return `${Math.round(value)}%`;
}

function usagePeak(row: UsageRow): number {
  return Math.max(row.h5pct, row.d7pct);
}

function usageLimitWindow(row: UsageRow): UsageLimitWindow {
  return row.d7pct >= row.h5pct ? 'd7' : 'h5';
}

function usageWindowRemaining(
  row: UsageRow,
  window: UsageLimitWindow,
): number | null {
  const pct = window === 'h5' ? row.h5pct : row.d7pct;
  if (pct < 0) return null;
  return Math.max(0, 100 - pct);
}

function usageRiskLevel(row: UsageRow): RiskLevel {
  const peak = usagePeak(row);
  if (peak >= 85) return 'critical';
  if (peak >= 65) return 'warn';
  return 'ok';
}

function usageActive(row: UsageRow): boolean {
  return row.name.includes('*');
}

function usageLimited(row: UsageRow): boolean {
  return row.name.includes('!');
}

function usageNameParts(row: UsageRow): {
  account: string;
  plan: string | null;
} {
  const cleaned = row.name.replace(/[*!]/g, '').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(' ');
  const plan = parts.at(-1) ?? null;
  if (plan && ['max', 'mid', 'pro', 'team'].includes(plan.toLowerCase())) {
    return { account: parts.slice(0, -1).join(' ') || cleaned, plan };
  }
  return { account: cleaned, plan: null };
}

function usageWindowReset(row: UsageRow, window: UsageLimitWindow): string {
  return (window === 'd7' ? row.d7reset : row.h5reset).trim();
}

function usageBurnRate(row: UsageRow): number | null {
  if (row.h5pct < 0) return null;
  return row.h5pct / 5;
}

function usageSpeedLevel(rate: number | null): RiskLevel {
  if (rate === null) return 'ok';
  if (rate >= 12) return 'critical';
  if (rate >= 7) return 'warn';
  return 'ok';
}

function formatUsageRate(rate: number | null): string {
  if (rate === null) return '-';
  if (rate > 0 && rate < 1) return '<1%/h';
  return `${Math.round(rate)}%/h`;
}

function usageGroup(row: UsageRow): UsageGroup {
  return row.name.toLowerCase().startsWith('codex') ? 'codex' : 'primary';
}

function UsageQuotaMeter({
  row,
  rowName,
  window,
  t,
}: {
  row: UsageRow;
  rowName: string;
  window: UsageLimitWindow;
  t: Messages;
}) {
  const remaining = usageWindowRemaining(row, window);
  const reset = usageWindowReset(row, window);
  const tightest = usageLimitWindow(row) === window;
  const label = t.usage.quota[window];

  return (
    <div className={`usage-quota ${tightest ? 'usage-quota-tight' : ''}`}>
      <div>
        <span>{label}</span>
        <strong>{remaining === null ? '-' : formatPct(remaining)}</strong>
      </div>
      <progress
        aria-label={`${rowName} ${label} ${
          remaining === null ? '-' : formatPct(remaining)
        }`}
        max={100}
        value={remaining ?? 0}
      />
      <small>{reset ? `${t.usage.reset} ${reset}` : t.usage.noReset}</small>
    </div>
  );
}

function UsageSpeed({ row, t }: { row: UsageRow; t: Messages }) {
  const rate = usageBurnRate(row);
  const level = usageSpeedLevel(rate);

  return (
    <div className={`usage-speed usage-speed-${level}`}>
      <span>{t.usage.speed}</span>
      <strong>{formatUsageRate(rate)}</strong>
      <small>{t.usage.speedLabel[level]}</small>
    </div>
  );
}

export function UsagePanel({ overview, t }: UsagePanelProps) {
  const rows = useMemo(
    () =>
      [...overview.usage.rows].sort((a, b) => {
        if (usageActive(a) !== usageActive(b)) return usageActive(a) ? -1 : 1;
        return usagePeak(b) - usagePeak(a);
      }),
    [overview.usage.rows],
  );
  const watched = rows.filter((row) => usagePeak(row) >= 65).length;

  if (rows.length === 0) {
    return <EmptyState>{t.usage.empty}</EmptyState>;
  }

  const activeRows = rows.filter(usageActive);
  const focusRows = activeRows.length > 0 ? activeRows : rows.slice(0, 1);
  const focusLabel = activeRows.length > 0 ? t.usage.current : t.usage.tightest;
  const focusValue = focusRows
    .map((row) => {
      const { account } = usageNameParts(row);
      const h5Remaining = usageWindowRemaining(row, 'h5');
      const d7Remaining = usageWindowRemaining(row, 'd7');
      return `${account} ${t.usage.quota.h5} ${
        h5Remaining === null ? '-' : formatPct(h5Remaining)
      } · ${t.usage.quota.d7} ${
        d7Remaining === null ? '-' : formatPct(d7Remaining)
      }`;
    })
    .join(' · ');
  const groups = [
    {
      key: 'primary' as const,
      label: t.usage.groupPrimary,
      rows: rows.filter((row) => usageGroup(row) === 'primary'),
    },
    {
      key: 'codex' as const,
      label: t.usage.groupCodex,
      rows: rows.filter((row) => usageGroup(row) === 'codex'),
    },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="usage-dashboard">
      <div className="usage-summary">
        <div>
          <span>{focusLabel}</span>
          <strong>{focusValue}</strong>
        </div>
        <div>
          <span>{t.usage.watch}</span>
          <strong>{watched}</strong>
        </div>
      </div>

      <div className="usage-matrix" role="table" aria-label={t.panels.usage}>
        <div className="usage-matrix-head" role="row">
          <span>{t.usage.usage}</span>
          <span>{t.usage.quota.h5}</span>
          <span>{t.usage.quota.d7}</span>
          <span>{t.usage.speed}</span>
        </div>
        {groups.map((group) => (
          <div className="usage-group" key={group.key} role="rowgroup">
            <div className="usage-group-label" role="row">
              <span>{group.label}</span>
            </div>
            {group.rows.map((row) => {
              const risk = usageRiskLevel(row);
              const { account, plan } = usageNameParts(row);
              return (
                <section className={`usage-row usage-${risk}`} key={row.name}>
                  <div className="usage-account">
                    <strong>{account}</strong>
                    <div>
                      {usageActive(row) ? (
                        <span className="pill pill-info">{t.usage.inUse}</span>
                      ) : null}
                      {plan ? <span className="mono-chip">{plan}</span> : null}
                      {usageLimited(row) || risk !== 'ok' ? (
                        <span className={`pill pill-${risk}`}>
                          {t.usage.risk[risk]}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <UsageQuotaMeter
                    row={row}
                    rowName={account}
                    window="h5"
                    t={t}
                  />
                  <UsageQuotaMeter
                    row={row}
                    rowName={account}
                    window="d7"
                    t={t}
                  />
                  <UsageSpeed row={row} t={t} />
                </section>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
