import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./claude-usage.js', () => ({
  fetchClaudeUsage: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    FALLBACK_PROVIDER_NAME: 'kimi',
    FALLBACK_BASE_URL: 'https://api.kimi.com/coding/',
    FALLBACK_AUTH_TOKEN: 'test-kimi-key',
    FALLBACK_MODEL: 'kimi-k2.5',
    FALLBACK_SMALL_MODEL: 'kimi-k2.5',
    FALLBACK_COOLDOWN_MS: '600000',
  })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { fetchClaudeUsage } from './claude-usage.js';
import {
  clearPrimaryCooldown,
  getActiveProvider,
  getCooldownInfo,
  markPrimaryCooldown,
  resetFallbackConfig,
} from './provider-fallback.js';

describe('provider fallback usage recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T00:00:00.000Z'));
    vi.clearAllMocks();
    clearPrimaryCooldown();
    resetFallbackConfig();
    delete process.env.FALLBACK_PROVIDER_NAME;
    delete process.env.FALLBACK_BASE_URL;
    delete process.env.FALLBACK_AUTH_TOKEN;
    delete process.env.FALLBACK_MODEL;
    delete process.env.FALLBACK_SMALL_MODEL;
    delete process.env.FALLBACK_COOLDOWN_MS;
  });

  afterEach(() => {
    clearPrimaryCooldown();
    resetFallbackConfig();
    vi.useRealTimers();
  });

  it('keeps the fallback provider active while Claude usage is still exhausted', async () => {
    vi.mocked(fetchClaudeUsage).mockResolvedValue({
      five_hour: {
        utilization: 100,
        resets_at: '2026-03-24T04:00:00.000+09:00',
      },
    });

    markPrimaryCooldown('usage-exhausted', 1_000);
    vi.advanceTimersByTime(5_000);

    await expect(getActiveProvider()).resolves.toBe('kimi');
    expect(getCooldownInfo()).toMatchObject({
      active: true,
      reason: 'usage-exhausted',
      remainingMs: 0,
    });
  });

  it('returns to Claude immediately when usage is no longer exhausted', async () => {
    vi.mocked(fetchClaudeUsage).mockResolvedValue({
      five_hour: {
        utilization: 72,
        resets_at: '2026-03-24T04:00:00.000+09:00',
      },
      seven_day: {
        utilization: 55,
        resets_at: '2026-03-31T04:00:00.000+09:00',
      },
    });

    markPrimaryCooldown('usage-exhausted', 600_000);

    await expect(getActiveProvider()).resolves.toBe('claude');
    expect(getCooldownInfo()).toEqual({ active: false });
  });

  it('falls back to time-based retry when usage status cannot be fetched', async () => {
    vi.mocked(fetchClaudeUsage).mockResolvedValue(null);

    markPrimaryCooldown('usage-exhausted', 1_000);
    vi.advanceTimersByTime(5_000);

    await expect(getActiveProvider()).resolves.toBe('claude');
    expect(getCooldownInfo()).toEqual({ active: false });
  });
});
