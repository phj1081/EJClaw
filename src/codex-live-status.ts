export interface CodexRateLimitWindowSummary {
  limitWindowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: string | null;
  usedPercent: number | null;
}

export interface CodexRateLimitSummary {
  allowed: boolean | null;
  limitReached: boolean | null;
  primaryWindow: CodexRateLimitWindowSummary | null;
  secondaryWindow: CodexRateLimitWindowSummary | null;
}

export interface CodexAdditionalRateLimitSummary {
  limitName: string | null;
  meteredFeature: string | null;
  rateLimit: CodexRateLimitSummary | null;
}

export interface CodexCreditsSummary {
  hasCredits: boolean | null;
  overageLimitReached: boolean | null;
  unlimited: boolean | null;
}

export interface CodexSpendControlSummary {
  reached: boolean | null;
}

export interface CodexLiveStatusSummary {
  checkedAt: string;
  source: 'wham/usage';
  planType: string | null;
  email: string | null;
  rateLimit: CodexRateLimitSummary | null;
  rateLimitReachedType: string | null;
  additionalRateLimits: CodexAdditionalRateLimitSummary[];
  credits: CodexCreditsSummary | null;
  spendControl: CodexSpendControlSummary | null;
}

interface CodexLiveRateLimitWindow {
  limit_window_seconds?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
  used_percent?: number | null;
}

interface CodexLiveRateLimit {
  allowed?: boolean | null;
  limit_reached?: boolean | null;
  primary_window?: CodexLiveRateLimitWindow | null;
  secondary_window?: CodexLiveRateLimitWindow | null;
}

interface CodexAdditionalLiveRateLimit {
  limit_name?: string | null;
  metered_feature?: string | null;
  rate_limit?: CodexLiveRateLimit | null;
}

interface CodexLiveCredits {
  has_credits?: boolean | null;
  overage_limit_reached?: boolean | null;
  unlimited?: boolean | null;
}

interface CodexLiveSpendControl {
  reached?: boolean | null;
}

export interface CodexLiveStatus {
  checked_at: string;
  plan_type?: string | null;
  email?: string | null;
  rate_limit?: CodexLiveRateLimit | null;
  rate_limit_reached_type?: string | null;
  additional_rate_limits?: CodexAdditionalLiveRateLimit[];
  credits?: CodexLiveCredits | null;
  spend_control?: CodexLiveSpendControl | null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function epochSecondsToIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function normalizeRateLimitWindow(
  value: unknown,
): CodexLiveRateLimitWindow | null {
  const record = recordOrNull(value);
  if (!record) return null;
  return {
    limit_window_seconds: numberOrNull(record.limit_window_seconds),
    reset_after_seconds: numberOrNull(record.reset_after_seconds),
    reset_at: numberOrNull(record.reset_at),
    used_percent: numberOrNull(record.used_percent),
  };
}

function normalizeRateLimit(value: unknown): CodexLiveRateLimit | null {
  const record = recordOrNull(value);
  if (!record) return null;
  return {
    allowed: booleanOrNull(record.allowed),
    limit_reached: booleanOrNull(record.limit_reached),
    primary_window: normalizeRateLimitWindow(record.primary_window),
    secondary_window: normalizeRateLimitWindow(record.secondary_window),
  };
}

function normalizeAdditionalRateLimits(
  value: unknown,
): CodexAdditionalLiveRateLimit[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): CodexAdditionalLiveRateLimit | null => {
      const record = recordOrNull(item);
      if (!record) return null;
      return {
        limit_name: stringOrNull(record.limit_name),
        metered_feature: stringOrNull(record.metered_feature),
        rate_limit: normalizeRateLimit(record.rate_limit),
      };
    })
    .filter((item): item is CodexAdditionalLiveRateLimit => item !== null);
}

function normalizeCredits(value: unknown): CodexLiveCredits | null {
  const record = recordOrNull(value);
  if (!record) return null;
  return {
    has_credits: booleanOrNull(record.has_credits),
    overage_limit_reached: booleanOrNull(record.overage_limit_reached),
    unlimited: booleanOrNull(record.unlimited),
  };
}

function normalizeSpendControl(value: unknown): CodexLiveSpendControl | null {
  const record = recordOrNull(value);
  if (!record) return null;
  return {
    reached: booleanOrNull(record.reached),
  };
}

export function normalizeCodexLiveStatus(
  value: unknown,
  checkedAt: string,
): CodexLiveStatus | null {
  const record = recordOrNull(value);
  if (!record) return null;
  return {
    checked_at: checkedAt,
    plan_type: stringOrNull(record.plan_type),
    email: stringOrNull(record.email),
    rate_limit: normalizeRateLimit(record.rate_limit),
    rate_limit_reached_type: stringOrNull(record.rate_limit_reached_type),
    additional_rate_limits: normalizeAdditionalRateLimits(
      record.additional_rate_limits,
    ),
    credits: normalizeCredits(record.credits),
    spend_control: normalizeSpendControl(record.spend_control),
  };
}

function toRateLimitWindowSummary(
  window: CodexLiveRateLimitWindow | null | undefined,
): CodexRateLimitWindowSummary | null {
  if (!window) return null;
  return {
    limitWindowSeconds: window.limit_window_seconds ?? null,
    resetAfterSeconds: window.reset_after_seconds ?? null,
    resetAt: epochSecondsToIso(window.reset_at),
    usedPercent: window.used_percent ?? null,
  };
}

function toRateLimitSummary(
  rateLimit: CodexLiveRateLimit | null | undefined,
): CodexRateLimitSummary | null {
  if (!rateLimit) return null;
  return {
    allowed: rateLimit.allowed ?? null,
    limitReached: rateLimit.limit_reached ?? null,
    primaryWindow: toRateLimitWindowSummary(rateLimit.primary_window),
    secondaryWindow: toRateLimitWindowSummary(rateLimit.secondary_window),
  };
}

export function toCodexLiveStatusSummary(
  status: CodexLiveStatus,
): CodexLiveStatusSummary {
  return {
    checkedAt: status.checked_at,
    source: 'wham/usage',
    planType: status.plan_type ?? null,
    email: status.email ?? null,
    rateLimit: toRateLimitSummary(status.rate_limit),
    rateLimitReachedType: status.rate_limit_reached_type ?? null,
    additionalRateLimits: (status.additional_rate_limits ?? []).map(
      (limit) => ({
        limitName: limit.limit_name ?? null,
        meteredFeature: limit.metered_feature ?? null,
        rateLimit: toRateLimitSummary(limit.rate_limit),
      }),
    ),
    credits: status.credits
      ? {
          hasCredits: status.credits.has_credits ?? null,
          overageLimitReached: status.credits.overage_limit_reached ?? null,
          unlimited: status.credits.unlimited ?? null,
        }
      : null,
    spendControl: status.spend_control
      ? {
          reached: status.spend_control.reached ?? null,
        }
      : null,
  };
}
