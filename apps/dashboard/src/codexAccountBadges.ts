import {
  type CodexLiveStatusSummary,
  type CodexRateLimitSummary,
  type CodexRateLimitWindowSummary,
} from './api';

export function formatDateTime(iso: string): string | null {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatJwtCacheExpiry(
  iso: string | null,
): { label: string; cls: string; title: string } | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  const days = (dt.getTime() - Date.now()) / 86400000;
  const dateStr = dt.toLocaleDateString('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  });
  const suffix =
    days < 0 ? `${Math.ceil(-days)}일 전` : `${Math.floor(days)}일 남음`;
  return {
    label: `JWT 캐시 ${dateStr}`,
    cls: 'is-stale',
    title: `OpenAI/Auth0 JWT 캐시 만료일입니다. live wham/usage 갱신값이 있으면 이 값은 표시하지 않습니다. (${suffix})`,
  };
}

function formatWindowName(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return 'limit';
  if (seconds % 86400 === 0) return `${Math.round(seconds / 86400)}d`;
  if (seconds % 3600 === 0) return `${Math.round(seconds / 3600)}h`;
  if (seconds % 60 === 0) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?%';
  return `${Math.round(value)}%`;
}

function formatRateLimitWindow(
  window: CodexRateLimitWindowSummary | null,
): string | null {
  if (!window) return null;
  return `${formatWindowName(window.limitWindowSeconds)} ${formatPercent(window.usedPercent)}`;
}

export function formatLiveStatusBadge(
  live: CodexLiveStatusSummary | null,
): { label: string; cls: string; title: string } | null {
  if (!live) return null;
  const limits = [
    live.rateLimit,
    ...live.additionalRateLimits.map((limit) => limit.rateLimit),
  ].filter((limit): limit is CodexRateLimitSummary => limit !== null);
  const anyReached = limits.some((limit) => limit.limitReached === true);
  const anyBlocked = limits.some((limit) => limit.allowed === false);
  const checkedAt = formatDateTime(live.checkedAt) ?? live.checkedAt;
  if (anyReached || anyBlocked || live.rateLimitReachedType) {
    return {
      label: 'live 제한 도달',
      cls: 'is-expired',
      title: `wham/usage live 확인: ${checkedAt}${
        live.rateLimitReachedType ? ` · ${live.rateLimitReachedType}` : ''
      }`,
    };
  }
  if (live.spendControl?.reached || live.credits?.overageLimitReached) {
    return {
      label: 'live 지출 제한',
      cls: 'is-expired',
      title: `wham/usage live 확인: ${checkedAt}`,
    };
  }
  if (limits.some((limit) => limit.allowed === true)) {
    return {
      label: 'live 사용 가능',
      cls: 'is-active',
      title: `wham/usage live 확인: ${checkedAt}`,
    };
  }
  return {
    label: 'live 확인됨',
    cls: 'is-soon',
    title: `wham/usage live 확인: ${checkedAt}`,
  };
}

export function formatUsageBadge(
  live: CodexLiveStatusSummary | null,
): { label: string; title: string } | null {
  if (!live?.rateLimit) return null;
  const primary = formatRateLimitWindow(live.rateLimit.primaryWindow);
  const secondary = formatRateLimitWindow(live.rateLimit.secondaryWindow);
  const label = [primary, secondary].filter(Boolean).join(' · ');
  if (!label) return null;
  const resetParts = [
    live.rateLimit.primaryWindow?.resetAt
      ? `primary reset ${formatDateTime(live.rateLimit.primaryWindow.resetAt) ?? live.rateLimit.primaryWindow.resetAt}`
      : null,
    live.rateLimit.secondaryWindow?.resetAt
      ? `secondary reset ${formatDateTime(live.rateLimit.secondaryWindow.resetAt) ?? live.rateLimit.secondaryWindow.resetAt}`
      : null,
  ].filter(Boolean);
  return {
    label,
    title: resetParts.join(' · ') || 'wham/usage live rate_limit',
  };
}
