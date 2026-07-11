/**
 * Claude Usage API
 *
 * Fetches usage data directly from the Anthropic OAuth API.
 * Supports multiple tokens for rotation-aware usage checking.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  getAllTokens,
  getConfiguredClaudeTokens,
  getCurrentToken,
  getCurrentTokenIndex,
} from './token-rotation.js';
import { forceRefreshToken } from './token-refresh.js';
import { readJsonFile, writeJsonFile } from './utils.js';

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
  /** Timestamp of last *successful* API fetch (use for stale detection). */
  fetchedAt: number;
  /** Timestamp of last API *attempt* including failures (use for throttling). */
  lastAttemptAt?: number;
}

let usageDiskCache: Record<string, UsageCacheEntry> = {};
let diskCacheLoaded = false;

function loadUsageDiskCache(): void {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  usageDiskCache =
    readJsonFile<Record<string, UsageCacheEntry>>(USAGE_CACHE_FILE) ?? {};
}

function saveUsageDiskCache(): void {
  try {
    writeJsonFile(USAGE_CACHE_FILE, usageDiskCache);
  } catch {
    /* best effort */
  }
}

function legacyTokenCacheKey(token: string): string {
  // Use last 8 chars — prefix is always "sk-ant-oat01-" for all tokens
  return token.slice(-8);
}

function accountCacheKey(accountIndex: number): string {
  return `account-${accountIndex}`;
}

export function getUsageCacheWriteKey(
  token: string,
  accountIndex?: number,
): string {
  return accountIndex != null
    ? accountCacheKey(accountIndex)
    : legacyTokenCacheKey(token);
}

export function getUsageCacheReadKeys(
  token: string,
  accountIndex?: number,
  credentialsAccessToken?: string | null,
): string[] {
  const keys: string[] = [];
  if (accountIndex != null) keys.push(accountCacheKey(accountIndex));

  if (credentialsAccessToken) {
    const credsKey = legacyTokenCacheKey(credentialsAccessToken);
    if (!keys.includes(credsKey)) keys.push(credsKey);
  }

  const tokenKey = legacyTokenCacheKey(token);
  if (!keys.includes(tokenKey)) keys.push(tokenKey);

  return keys;
}

// Rate limit: at most one API call per token per 5 minutes
const MIN_FETCH_INTERVAL_MS = 300_000;
const FAILURE_COOLDOWN_MS = 10 * 60_000;

const usageCooldownUntil = new Map<number, number>();
const refreshAttemptedAt = new Map<number, number>();

interface BearerTokenSelection {
  token: string;
  source: 'credentials' | 'env';
  credentialsAccessToken: string | null;
}

function selectBearerToken(
  envToken: string,
  accountIndex?: number,
): BearerTokenSelection {
  const credentialsAccessToken =
    accountIndex != null ? readCredentialsAccessToken(accountIndex) : null;
  return {
    token: credentialsAccessToken ?? envToken,
    source: credentialsAccessToken ? 'credentials' : 'env',
    credentialsAccessToken,
  };
}

async function requestUsage(token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'ejclaw/1.0',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsageForToken(
  token: string,
  accountIndex?: number,
): Promise<ClaudeUsageData | null> {
  loadUsageDiskCache();

  // Return cached data if attempted recently (avoid API rate-limit)
  const selectedBearer = selectBearerToken(token, accountIndex);
  const writeKey = getUsageCacheWriteKey(token, accountIndex);
  const readKeys = getUsageCacheReadKeys(
    token,
    accountIndex,
    selectedBearer.credentialsAccessToken,
  );
  let cachedKey: string | null = null;
  let cached: UsageCacheEntry | undefined;
  for (const key of readKeys) {
    const entry = usageDiskCache[key];
    if (!entry) continue;
    cachedKey = key;
    cached = entry;
    break;
  }
  if (
    cached &&
    cachedKey &&
    cachedKey !== writeKey &&
    !usageDiskCache[writeKey]
  ) {
    usageDiskCache[writeKey] = { ...cached };
    cached = usageDiskCache[writeKey];
    saveUsageDiskCache();
  }
  const lastAttempt = cached?.lastAttemptAt ?? cached?.fetchedAt ?? 0;
  if (cached && Date.now() - lastAttempt < MIN_FETCH_INTERVAL_MS) {
    return cached.usage;
  }

  const now = Date.now();
  if (
    accountIndex != null &&
    (usageCooldownUntil.get(accountIndex) ?? 0) > now
  ) {
    logger.debug(
      { account: accountIndex + 1 },
      'Claude usage API: account is in failure cooldown, returning cached data',
    );
    return cached?.usage ?? null;
  }

  logger.debug(
    {
      account: accountIndex != null ? accountIndex + 1 : '?',
      source: selectedBearer.source,
    },
    'Claude usage API: selected bearer token',
  );

  try {
    let res = await requestUsage(selectedBearer.token);

    if (res.status === 401) {
      if (accountIndex != null) {
        usageCooldownUntil.set(accountIndex, Date.now() + FAILURE_COOLDOWN_MS);
      }
      logger.warn(
        {
          account: accountIndex != null ? accountIndex + 1 : '?',
        },
        'Claude usage API: token expired or invalid (401)',
      );

      const lastRefreshAttempt =
        accountIndex != null ? (refreshAttemptedAt.get(accountIndex) ?? 0) : 0;
      if (
        accountIndex != null &&
        Date.now() - lastRefreshAttempt >= FAILURE_COOLDOWN_MS
      ) {
        refreshAttemptedAt.set(accountIndex, Date.now());
        let refreshedToken: string | null = null;
        try {
          refreshedToken = await forceRefreshToken(accountIndex);
        } catch {
          logger.warn(
            { account: accountIndex + 1 },
            'Claude usage API: token refresh failed unexpectedly',
          );
        }
        if (refreshedToken) {
          res = await requestUsage(refreshedToken);
        } else {
          return cached?.usage ?? null;
        }
      } else {
        return cached?.usage ?? null;
      }
    }
    if (res.status === 401) {
      logger.warn(
        { account: accountIndex != null ? accountIndex + 1 : '?' },
        'Claude usage API: refreshed token was rejected (401)',
      );
      return cached?.usage ?? null;
    }
    if (res.status === 429) {
      if (accountIndex != null) {
        usageCooldownUntil.set(accountIndex, Date.now() + FAILURE_COOLDOWN_MS);
      }
      const staleMs = cached ? Date.now() - cached.fetchedAt : 0;
      logger.warn(
        {
          account: accountIndex != null ? accountIndex + 1 : '?',
          staleMinutes: Math.round(staleMs / 60_000),
        },
        'Claude usage API: rate limited (429), returning cached data',
      );
      // Record attempt time so we don't retry for MIN_FETCH_INTERVAL_MS
      if (cached) {
        cached.lastAttemptAt = Date.now();
        saveUsageDiskCache();
      }
      return cached?.usage ?? null;
    }
    if (!res.ok) {
      logger.warn(
        {
          account: accountIndex != null ? accountIndex + 1 : '?',
          status: res.status,
        },
        `Claude usage API: unexpected status ${res.status}`,
      );
      if (cached) {
        cached.lastAttemptAt = Date.now();
        saveUsageDiskCache();
      }
      return cached?.usage ?? null;
    }

    const data = (await res.json()) as UsageApiResponse;

    const result: ClaudeUsageData = {
      five_hour: mapWindow(data.five_hour),
      seven_day: mapWindow(data.seven_day),
      seven_day_sonnet: mapWindow(data.seven_day_sonnet),
      seven_day_opus: mapWindow(data.seven_day_opus),
    };

    // Persist to disk cache — success: update both fetchedAt and lastAttemptAt
    const now = Date.now();
    usageDiskCache[writeKey] = {
      usage: result,
      fetchedAt: now,
      lastAttemptAt: now,
    };
    if (accountIndex != null) {
      usageCooldownUntil.delete(accountIndex);
    }
    saveUsageDiskCache();

    logger.debug(
      {
        account: accountIndex != null ? accountIndex + 1 : '?',
        h5: result.five_hour?.utilization,
        d7: result.seven_day?.utilization,
      },
      'Claude usage API: fetched successfully',
    );

    return result;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logger.warn(
        {
          account: accountIndex != null ? accountIndex + 1 : '?',
        },
        'Claude usage API: request timed out',
      );
    } else {
      logger.warn(
        {
          err,
          account: accountIndex != null ? accountIndex + 1 : '?',
        },
        'Claude usage API: fetch failed',
      );
    }
    // Record attempt time so we back off on persistent failures
    if (cached) {
      cached.lastAttemptAt = Date.now();
      saveUsageDiskCache();
    }
    return cached?.usage ?? null;
  }
}

/**
 * Fetch Claude usage via the OAuth API.
 * Uses the current active token from rotation.
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  const token = getCurrentToken() || getConfiguredClaudeTokens()[0];
  if (!token) {
    logger.debug('No Claude OAuth token available for usage check');
    return null;
  }
  return fetchUsageForToken(token, getCurrentTokenIndex() ?? 0);
}

export interface ClaudeAccountProfile {
  email: string;
  planType: string; // "max", "pro", "free"
}

const profileCache = new Map<number, ClaudeAccountProfile>();

/**
 * Read planType from credentials file as fallback when profile API fails.
 * Account 0: ~/.claude/.credentials.json
 * Account 1+: ~/.claude-accounts/{index}/.credentials.json
 */
function readCredentialsPlanType(accountIndex: number): string | null {
  try {
    const credsPath =
      accountIndex === 0
        ? path.join(os.homedir(), '.claude', '.credentials.json')
        : path.join(
            os.homedir(),
            '.claude-accounts',
            String(accountIndex),
            '.credentials.json',
          );
    if (!fs.existsSync(credsPath)) return null;
    const data = readJsonFile<{
      claudeAiOauth?: { subscriptionType?: string };
    }>(credsPath);
    return data?.claudeAiOauth?.subscriptionType || null;
  } catch {
    return null;
  }
}

function readCredentialsAccessToken(accountIndex: number): string | null {
  try {
    const credsPath =
      accountIndex === 0
        ? path.join(os.homedir(), '.claude', '.credentials.json')
        : path.join(
            os.homedir(),
            '.claude-accounts',
            String(accountIndex),
            '.credentials.json',
          );
    if (!fs.existsSync(credsPath)) return null;
    const data = readJsonFile<{
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    }>(credsPath);
    const oauth = data?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) {
      return null;
    }
    return oauth.accessToken;
  } catch {
    return null;
  }
}

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
        : orgType.replace('claude_', '') || '?';
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
    const selectedBearer = selectBearerToken(t.token, t.index);
    logger.debug(
      { account: t.index + 1, source: selectedBearer.source },
      'Claude profile API: selected bearer token',
    );
    let profile = await fetchProfileForToken(selectedBearer.token);

    // Fallback: if profile API failed or returned unknown plan, use credentials file
    if (!profile || profile.planType === '?') {
      const credsPlan = readCredentialsPlanType(t.index);
      if (credsPlan) {
        profile = {
          email: profile?.email || '?',
          planType: credsPlan,
        };
        logger.info(
          { account: t.index + 1, plan: credsPlan, source: 'credentials' },
          `Claude account #${t.index + 1}: ${credsPlan} (from credentials)`,
        );
      }
    }

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
    const token = getConfiguredClaudeTokens()[0];
    if (!token) return [];
    const usage = await fetchUsageForToken(token, 0);
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
    const usage = await fetchUsageForToken(t.token, t.index);
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
