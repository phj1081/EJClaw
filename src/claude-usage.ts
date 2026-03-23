/**
 * Claude Usage API
 *
 * Fetches usage data directly from the Anthropic OAuth API.
 * Supports multiple tokens for rotation-aware usage checking.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { getCurrentToken, getAllTokens } from './token-rotation.js';

const USAGE_CACHE_FILE = path.join(DATA_DIR, 'claude-usage-cache.json');

const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';

export interface ClaudeUsageData {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  seven_day_sonnet?: { utilization: number; resets_at: string };
  seven_day_opus?: { utilization: number; resets_at: string };
}

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 10_000;

interface UsageApiResponse {
  five_hour?: { utilization: number; resets_at?: string };
  seven_day?: { utilization: number; resets_at?: string };
  seven_day_sonnet?: { utilization: number; resets_at?: string };
  seven_day_opus?: { utilization: number; resets_at?: string };
}

function mapWindow(w?: {
  utilization: number;
  resets_at?: string;
}): { utilization: number; resets_at: string } | undefined {
  if (!w) return undefined;
  return { utilization: w.utilization, resets_at: w.resets_at || '' };
}

// ── Disk cache for usage data (survives restarts, 429s) ──

interface UsageCacheEntry {
  usage: ClaudeUsageData;
  fetchedAt: number;
}

let usageDiskCache: Record<string, UsageCacheEntry> = {};
let diskCacheLoaded = false;

function loadUsageDiskCache(): void {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    if (fs.existsSync(USAGE_CACHE_FILE)) {
      usageDiskCache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf-8'));
    }
  } catch {
    /* start fresh */
  }
}

function saveUsageDiskCache(): void {
  try {
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(usageDiskCache));
  } catch {
    /* best effort */
  }
}

function cacheKey(token: string): string {
  return token.slice(0, 12);
}

// Rate limit: at most one API call per token per 5 minutes
const MIN_FETCH_INTERVAL_MS = 300_000;

async function fetchUsageForToken(
  token: string,
): Promise<ClaudeUsageData | null> {
  loadUsageDiskCache();

  // Return cached data if fetched recently (avoid API rate-limit)
  const key = cacheKey(token);
  const cached = usageDiskCache[key];
  if (cached && Date.now() - cached.fetchedAt < MIN_FETCH_INTERVAL_MS) {
    return cached.usage;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'ejclaw/1.0',
      },
      signal: controller.signal,
    });

    if (res.status === 401) {
      logger.warn('Claude usage API: token expired or invalid (401)');
      return null;
    }
    if (res.status === 429) {
      logger.warn(
        'Claude usage API: rate limited (429), returning cached data',
      );
      return usageDiskCache[cacheKey(token)]?.usage ?? null;
    }
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        `Claude usage API: unexpected status ${res.status}`,
      );
      return usageDiskCache[cacheKey(token)]?.usage ?? null;
    }

    const data = (await res.json()) as UsageApiResponse;

    const result: ClaudeUsageData = {
      five_hour: mapWindow(data.five_hour),
      seven_day: mapWindow(data.seven_day),
      seven_day_sonnet: mapWindow(data.seven_day_sonnet),
      seven_day_opus: mapWindow(data.seven_day_opus),
    };

    // Persist to disk cache
    usageDiskCache[cacheKey(token)] = { usage: result, fetchedAt: Date.now() };
    saveUsageDiskCache();

    return result;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logger.warn('Claude usage API: request timed out');
    } else {
      logger.warn({ err }, 'Claude usage API: fetch failed');
    }
    return usageDiskCache[cacheKey(token)]?.usage ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch Claude usage via the OAuth API.
 * Uses the current active token from rotation.
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  const token = getCurrentToken() || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    logger.debug('No Claude OAuth token available for usage check');
    return null;
  }
  return fetchUsageForToken(token);
}

export interface ClaudeAccountProfile {
  email: string;
  planType: string; // "max", "pro", "free"
}

const profileCache = new Map<number, ClaudeAccountProfile>();

async function fetchProfileForToken(
  token: string,
): Promise<ClaudeAccountProfile | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(PROFILE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      account?: {
        email?: string;
        has_claude_max?: boolean;
        has_claude_pro?: boolean;
      };
      organization?: { organization_type?: string };
    };
    const orgType = data.organization?.organization_type || '';
    const planType = data.account?.has_claude_max
      ? 'max'
      : data.account?.has_claude_pro
        ? 'pro'
        : orgType.replace('claude_', '') || 'free';
    return {
      email: data.account?.email || '?',
      planType,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch profiles for all Claude tokens (cached, called once on startup).
 */
export async function fetchAllClaudeProfiles(): Promise<void> {
  const allTokens = getAllTokens();
  for (const t of allTokens) {
    const profile = await fetchProfileForToken(t.token);
    if (profile) {
      profileCache.set(t.index, profile);
      logger.info(
        { account: t.index + 1, plan: profile.planType, email: profile.email },
        `Claude account #${t.index + 1}: ${profile.planType}`,
      );
    }
  }
}

export function getClaudeProfile(
  index: number,
): ClaudeAccountProfile | undefined {
  return profileCache.get(index);
}

export interface ClaudeAccountUsage {
  index: number;
  masked: string;
  isActive: boolean;
  isRateLimited: boolean;
  usage: ClaudeUsageData | null;
}

/**
 * Fetch usage for ALL configured tokens.
 * Returns per-account usage for dashboard display.
 */
export async function fetchAllClaudeUsage(): Promise<ClaudeAccountUsage[]> {
  const allTokens = getAllTokens();
  logger.debug({ tokenCount: allTokens.length }, 'fetchAllClaudeUsage called');
  if (allTokens.length === 0) {
    // Single token fallback
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) return [];
    const usage = await fetchUsageForToken(token);
    return [
      {
        index: 0,
        masked: `${token.slice(0, 20)}...${token.slice(-4)}`,
        isActive: true,
        isRateLimited: false,
        usage,
      },
    ];
  }

  const results: ClaudeAccountUsage[] = [];
  for (const t of allTokens) {
    const usage = await fetchUsageForToken(t.token);
    results.push({
      index: t.index,
      masked: t.masked,
      isActive: t.isActive,
      isRateLimited: t.isRateLimited,
      usage,
    });
  }
  return results;
}

// Legacy alias
export const fetchClaudeUsageViaCli = fetchClaudeUsage;
