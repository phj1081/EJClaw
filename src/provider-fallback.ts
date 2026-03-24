/**
 * Provider Fallback Module
 *
 * Manages automatic fallback from the primary provider (Claude) to a
 * fallback provider (e.g. Kimi K2.5) when 429/rate-limit or network
 * errors are detected.
 *
 * Cooldown-based recovery:
 *   Claude 429 → immediate Kimi retry for that turn
 *   Claude enters cooldown (retry-after header or default 10 min)
 *   During cooldown → skip Claude, route directly to fallback
 *   After cooldown → try Claude first again
 */

import fs from 'fs';

import { fetchClaudeUsage, type ClaudeUsageData } from './claude-usage.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { rotateToken, getTokenCount } from './token-rotation.js';

// ── Types ────────────────────────────────────────────────────────

export type ProviderName = 'claude' | string; // fallback name is configurable

export interface FallbackTriggerResult {
  shouldFallback: boolean;
  reason: string;
  retryAfterMs?: number;
}

interface CooldownState {
  startedAt: number;
  expiresAt: number;
  reason: string;
}

interface FallbackConfig {
  enabled: boolean;
  providerName: string; // e.g. "kimi"
  baseUrl: string;
  authToken: string;
  model: string;
  smallModel: string;
  defaultCooldownMs: number;
}

// ── State ────────────────────────────────────────────────────────

let cooldown: CooldownState | null = null;
let lastUsageAvailabilityCheck: {
  checkedAt: number;
  result: 'available' | 'exhausted' | 'unknown';
} | null = null;
let usageAvailabilityCheckPromise: Promise<
  'available' | 'exhausted' | 'unknown'
> | null = null;

const USAGE_RECOVERY_RECHECK_MS = 30_000;

// ── Config ───────────────────────────────────────────────────────

let _config: FallbackConfig | null = null;

function loadConfig(): FallbackConfig {
  if (_config) return _config;

  const env = readEnvFile([
    'FALLBACK_PROVIDER_NAME',
    'FALLBACK_BASE_URL',
    'FALLBACK_AUTH_TOKEN',
    'FALLBACK_MODEL',
    'FALLBACK_SMALL_MODEL',
    'FALLBACK_COOLDOWN_MS',
  ]);

  const baseUrl = process.env.FALLBACK_BASE_URL || env.FALLBACK_BASE_URL || '';
  const authToken =
    process.env.FALLBACK_AUTH_TOKEN || env.FALLBACK_AUTH_TOKEN || '';
  const model = process.env.FALLBACK_MODEL || env.FALLBACK_MODEL || '';

  _config = {
    enabled: Boolean(baseUrl && authToken && model),
    providerName:
      process.env.FALLBACK_PROVIDER_NAME ||
      env.FALLBACK_PROVIDER_NAME ||
      'kimi',
    baseUrl,
    authToken,
    model,
    smallModel:
      process.env.FALLBACK_SMALL_MODEL || env.FALLBACK_SMALL_MODEL || model,
    defaultCooldownMs: parseInt(
      process.env.FALLBACK_COOLDOWN_MS || env.FALLBACK_COOLDOWN_MS || '600000',
      10,
    ),
  };

  if (_config.enabled) {
    logger.info(
      {
        provider: _config.providerName,
        model: _config.model,
        cooldownMs: _config.defaultCooldownMs,
      },
      'Provider fallback configured',
    );
  }

  return _config;
}

/** Force re-read of config (useful after .env changes). */
export function resetFallbackConfig(): void {
  _config = null;
}

// ── Public API ───────────────────────────────────────────────────

/** Check whether the fallback system is configured and available. */
export function isFallbackEnabled(): boolean {
  return loadConfig().enabled;
}

/** Get the display name of the fallback provider (e.g. "kimi"). */
export function getFallbackProviderName(): string {
  return loadConfig().providerName;
}

function normalizeUtilization(utilization: number): number {
  return utilization > 1 ? utilization : utilization * 100;
}

type ClaudeUsageWindow = NonNullable<ClaudeUsageData[keyof ClaudeUsageData]>;

function hasExhaustedClaudeUsageWindow(
  usage: ClaudeUsageData | null,
): boolean | null {
  if (!usage) return null;
  const windows: ClaudeUsageWindow[] = [];
  if (usage.five_hour) windows.push(usage.five_hour);
  if (usage.seven_day) windows.push(usage.seven_day);
  if (usage.seven_day_sonnet) windows.push(usage.seven_day_sonnet);
  if (usage.seven_day_opus) windows.push(usage.seven_day_opus);
  if (windows.length === 0) return null;
  return windows.some(
    (window) => normalizeUtilization(window.utilization) >= 100,
  );
}

function clearUsageAvailabilityCache(): void {
  lastUsageAvailabilityCheck = null;
  usageAvailabilityCheckPromise = null;
}

async function getClaudeUsageAvailability(): Promise<
  'available' | 'exhausted' | 'unknown'
> {
  const now = Date.now();
  if (
    lastUsageAvailabilityCheck &&
    now - lastUsageAvailabilityCheck.checkedAt < USAGE_RECOVERY_RECHECK_MS
  ) {
    return lastUsageAvailabilityCheck.result;
  }

  if (!usageAvailabilityCheckPromise) {
    usageAvailabilityCheckPromise = (async () => {
      const usage = await fetchClaudeUsage();
      const exhausted = hasExhaustedClaudeUsageWindow(usage);
      const result =
        exhausted === null ? 'unknown' : exhausted ? 'exhausted' : 'available';
      lastUsageAvailabilityCheck = {
        checkedAt: Date.now(),
        result,
      };
      return result;
    })();

    void usageAvailabilityCheckPromise.finally(() => {
      usageAvailabilityCheckPromise = null;
    });
  }

  return usageAvailabilityCheckPromise;
}

/**
 * Determine which provider should be used for the next request.
 * Returns 'claude' when Claude is healthy or cooldown has expired,
 * or the fallback provider name during an active cooldown.
 */
export async function getActiveProvider(): Promise<string> {
  const config = loadConfig();
  if (!config.enabled) return 'claude';

  if (cooldown) {
    if (cooldown.reason === 'usage-exhausted') {
      const usageAvailability = await getClaudeUsageAvailability();
      if (usageAvailability === 'available') {
        logger.info(
          {
            provider: 'claude',
            reason: cooldown.reason,
          },
          'Claude usage recovered, retrying primary provider',
        );
        cooldown = null;
        clearUsageAvailabilityCache();
        return 'claude';
      }
      if (usageAvailability === 'exhausted') {
        // Current token exhausted — try rotating to another token (ignore cooldowns)
        if (
          getTokenCount() > 1 &&
          rotateToken(undefined, { ignoreRateLimits: true })
        ) {
          logger.info(
            'Claude current token exhausted, rotated to next token — retrying',
          );
          cooldown = null;
          clearUsageAvailabilityCache();
          return 'claude';
        }
        logger.debug(
          {
            provider: config.providerName,
            reason: cooldown.reason,
          },
          'All Claude tokens exhausted, keeping cooldown active',
        );
        return config.providerName;
      }
    }

    if (Date.now() < cooldown.expiresAt) {
      return config.providerName;
    }
    // Cooldown expired — try Claude again
    logger.info(
      {
        provider: 'claude',
        cooldownDurationMs: cooldown.expiresAt - cooldown.startedAt,
        reason: cooldown.reason,
      },
      'Claude cooldown expired, retrying primary provider',
    );
    cooldown = null;
  }

  return 'claude';
}

/**
 * Mark Claude as rate-limited. All subsequent requests will route to
 * the fallback provider until the cooldown expires.
 */
export function markPrimaryCooldown(
  reason: string,
  retryAfterMs?: number,
): void {
  const config = loadConfig();
  const durationMs = retryAfterMs || config.defaultCooldownMs;
  const now = Date.now();

  cooldown = {
    startedAt: now,
    expiresAt: now + durationMs,
    reason,
  };
  clearUsageAvailabilityCache();

  logger.info(
    {
      reason,
      cooldownMs: durationMs,
      expiresAt: new Date(cooldown.expiresAt).toISOString(),
      fallbackProvider: config.providerName,
    },
    `Falling back to provider: ${config.providerName} (reason: ${reason}, cooldownMs: ${durationMs})`,
  );
}

/** Manually clear cooldown (e.g. after a successful Claude response). */
export function clearPrimaryCooldown(): void {
  clearUsageAvailabilityCache();
  if (cooldown) {
    logger.info(
      { reason: cooldown.reason },
      'Claude cooldown cleared manually',
    );
    cooldown = null;
  }
}

/** Check if Claude is currently in usage-exhausted cooldown. */
export function isUsageExhausted(): boolean {
  return cooldown?.reason === 'usage-exhausted';
}

/** Get current cooldown info (for diagnostics / status dashboard). */
export function getCooldownInfo(): {
  active: boolean;
  reason?: string;
  expiresAt?: string;
  remainingMs?: number;
} {
  if (!cooldown) {
    return { active: false };
  }
  const remainingMs = Math.max(cooldown.expiresAt - Date.now(), 0);
  if (cooldown.reason !== 'usage-exhausted' && remainingMs === 0) {
    return { active: false };
  }
  return {
    active: true,
    reason: cooldown.reason,
    expiresAt: new Date(cooldown.expiresAt).toISOString(),
    remainingMs,
  };
}

/**
 * Build the env-var overrides that make Claude Code SDK talk to
 * the fallback provider instead of Claude.
 */
export function getFallbackEnvOverrides(): Record<string, string> {
  const config = loadConfig();
  return {
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_AUTH_TOKEN: config.authToken,
    ANTHROPIC_MODEL: config.model,
    ANTHROPIC_SMALL_FAST_MODEL: config.smallModel,
    // Disable non-essential traffic (usage telemetry etc.) on fallback
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Generous timeout for third-party APIs
    API_TIMEOUT_MS: '3000000',
    // Disable tool search (not supported by most fallback providers)
    ENABLE_TOOL_SEARCH: 'false',
  };
}

/**
 * Inspect an agent error string and decide whether it warrants
 * a provider fallback.
 *
 * Triggers:
 *   - 429 / rate limit / too many requests
 *   - 503 / overloaded (transient provider issue)
 *   - Network / connection errors
 *
 * Does NOT trigger for:
 *   - Poisoned sessions
 *   - Prompt / tool failures
 *   - Timeouts (agent took too long, not a provider issue)
 */
export function detectFallbackTrigger(
  error?: string | null,
): FallbackTriggerResult {
  if (!error) return { shouldFallback: false, reason: '' };

  const lower = error.toLowerCase();

  // 429 Rate Limit
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('usage limit') ||
    lower.includes('hit your limit') ||
    lower.includes('too many requests') ||
    lower.includes('rate_limit')
  ) {
    // Try to extract retry-after value (seconds → ms)
    const retryMatch = error.match(/retry[\s_-]*after[:\s]*(\d+)/i);
    const retryAfterMs = retryMatch
      ? parseInt(retryMatch[1], 10) * 1000
      : undefined;
    return { shouldFallback: true, reason: '429', retryAfterMs };
  }

  if (
    (lower.includes('failed to authenticate') ||
      lower.includes('authentication_error')) &&
    (lower.includes('401') || lower.includes('unauthorized')) &&
    (lower.includes('oauth token has expired') ||
      lower.includes('obtain a new token') ||
      lower.includes('refresh your existing token') ||
      lower.includes('invalid authentication credentials') ||
      lower.includes('terminated'))
  ) {
    return { shouldFallback: true, reason: 'auth-expired' };
  }

  // 503 Overloaded
  if (lower.includes('503') || lower.includes('overloaded')) {
    return { shouldFallback: true, reason: 'overloaded' };
  }

  // Network / connection errors
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network error')
  ) {
    return { shouldFallback: true, reason: 'network-error' };
  }

  return { shouldFallback: false, reason: '' };
}

/**
 * Check whether a per-group settings.json already overrides the
 * provider (e.g. the Kimi test channel). If so, we should NOT
 * apply fallback env overrides on top — the channel already has
 * its own provider configuration.
 */
export function hasGroupProviderOverride(settingsJsonPath: string): boolean {
  try {
    const raw = fs.readFileSync(settingsJsonPath, 'utf-8');
    const settings = JSON.parse(raw);
    const env = settings?.env || {};
    return Boolean(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL);
  } catch {
    return false;
  }
}
