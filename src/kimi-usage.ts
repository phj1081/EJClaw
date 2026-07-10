/**
 * Kimi Usage API
 *
 * Fetches subscription quota usage from the Kimi Code API.
 * Endpoint: GET https://api.kimi.com/coding/v1/usages
 * Auth: Bearer token (same as FALLBACK_AUTH_TOKEN or MOA_KIMI_API_KEY)
 *
 * Response maps to the same 5h / weekly window structure as Claude/Codex.
 */

import { getEnv } from './env.js';
import { logger } from './logger.js';
import { formatResetRemaining, type UsageRow } from './dashboard-usage-rows.js';

// ── Types ────────────────────────────────────────────────────────

export interface KimiUsageResponse {
  user?: {
    userId?: string;
    region?: string;
    membership?: { level?: string };
  };
  /** Weekly (rolling) quota */
  usage?: {
    limit?: string;
    used?: string;
    remaining?: string;
    resetTime?: string;
  };
  /** Per-window limits (e.g. 5-hour sliding window) */
  limits?: Array<{
    window?: { duration?: number; timeUnit?: string };
    detail?: {
      limit?: string;
      used?: string;
      remaining?: string;
      resetTime?: string;
    };
  }>;
  parallel?: { limit?: string };
}

export interface KimiUsageData {
  /** 5-hour sliding window */
  fiveHour?: { pct: number; resetTime: string };
  /** Weekly rolling quota */
  weekly?: { pct: number; resetTime: string };
  /** Membership level (e.g. "LEVEL_INTERMEDIATE") */
  membershipLevel?: string;
}

// ── Config ───────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;
const MIN_FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;

let lastFetchAt = 0;
let cachedData: KimiUsageData | null = null;
let consecutiveFailures = 0;
let nextRetryAt = 0;

function recordFetchFailure(now: number): void {
  const delayMs = Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** consecutiveFailures,
    FAILURE_BACKOFF_MAX_MS,
  );
  consecutiveFailures += 1;
  nextRetryAt = now + delayMs;
}

function resetFetchFailures(): void {
  consecutiveFailures = 0;
  nextRetryAt = 0;
}

function getKimiConfig(): { baseUrl: string; authToken: string } | null {
  // Try MoA config first, then fallback config
  const authToken =
    getEnv('MOA_KIMI_API_KEY') || getEnv('FALLBACK_AUTH_TOKEN') || '';
  const baseUrl =
    getEnv('MOA_KIMI_BASE_URL') || getEnv('FALLBACK_BASE_URL') || '';
  if (!baseUrl || !authToken) return null;
  return { baseUrl, authToken };
}

// ── Parsing ──────────────────────────────────────────────────────

function parseWindowPct(detail?: {
  limit?: string;
  used?: string;
  remaining?: string;
}): number {
  if (!detail) return -1;
  const limit = parseInt(detail.limit || '0', 10);
  if (limit <= 0) return -1;

  if (detail.used != null) {
    const used = parseInt(detail.used, 10);
    return Math.round((used / limit) * 100);
  }
  if (detail.remaining != null) {
    const remaining = parseInt(detail.remaining, 10);
    return Math.round(((limit - remaining) / limit) * 100);
  }
  return -1;
}

function parseResponse(resp: KimiUsageResponse): KimiUsageData {
  const data: KimiUsageData = {};

  // Weekly quota (top-level "usage" field)
  if (resp.usage) {
    const pct = parseWindowPct(resp.usage);
    data.weekly = { pct, resetTime: resp.usage.resetTime || '' };
  }

  // 5-hour sliding window (first entry in "limits" array)
  if (resp.limits && resp.limits.length > 0) {
    const first = resp.limits[0];
    if (first.detail) {
      const pct = parseWindowPct(first.detail);
      data.fiveHour = { pct, resetTime: first.detail.resetTime || '' };
    }
  }

  // Membership
  data.membershipLevel = resp.user?.membership?.level;

  return data;
}

// ── Fetch ────────────────────────────────────────────────────────

export async function fetchKimiUsage(): Promise<KimiUsageData | null> {
  const config = getKimiConfig();
  if (!config) return null;

  const now = Date.now();
  if (now < nextRetryAt) return cachedData;
  if (now - lastFetchAt < MIN_FETCH_INTERVAL_MS && cachedData) {
    return cachedData;
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/usages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.authToken}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      recordFetchFailure(Date.now());
      logger.warn(
        { status: response.status, url },
        'Kimi usage API returned non-OK status',
      );
      return cachedData; // Return stale cache on failure
    }

    const json = (await response.json()) as KimiUsageResponse;
    cachedData = parseResponse(json);
    lastFetchAt = Date.now();
    resetFetchFailures();

    logger.debug(
      {
        weeklyPct: cachedData.weekly?.pct,
        fiveHourPct: cachedData.fiveHour?.pct,
        membership: cachedData.membershipLevel,
      },
      'Kimi usage fetched',
    );

    return cachedData;
  } catch (err) {
    recordFetchFailure(Date.now());
    logger.warn({ err, url }, 'Failed to fetch Kimi usage');
    return cachedData; // Return stale cache on failure
  } finally {
    clearTimeout(timer);
  }
}

// ── UsageRow builder ─────────────────────────────────────────────

function formatMembershipLabel(level?: string): string {
  if (!level) return '';
  // "LEVEL_INTERMEDIATE" → "mid", "LEVEL_PREMIUM" → "premium", etc.
  const cleaned = level.replace(/^LEVEL_/i, '').toLowerCase();
  const labelMap: Record<string, string> = {
    basic: 'basic',
    intermediate: 'mid',
    premium: 'premium',
    enterprise: 'ent',
  };
  return labelMap[cleaned] || cleaned;
}

export function buildKimiUsageRows(data: KimiUsageData | null): UsageRow[] {
  if (!data) return [];

  const memberLabel = formatMembershipLabel(data.membershipLevel);
  const name = memberLabel ? `Kimi ${memberLabel}` : 'Kimi';

  return [
    {
      name,
      h5pct: data.fiveHour?.pct ?? -1,
      h5reset: data.fiveHour?.resetTime
        ? formatResetRemaining(data.fiveHour.resetTime)
        : '',
      d7pct: data.weekly?.pct ?? -1,
      d7reset: data.weekly?.resetTime
        ? formatResetRemaining(data.weekly.resetTime)
        : '',
    },
  ];
}

/** Force clear cached data (for testing). */
export function resetKimiUsageCache(): void {
  cachedData = null;
  lastFetchAt = 0;
  resetFetchFailures();
}
