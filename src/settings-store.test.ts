import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCodexFeatures,
  listCodexAccounts,
  refreshCodexAccount,
  updateCodexFeatures,
} from './settings-store.js';

describe('settings-store Codex features', () => {
  let tempDir: string;
  let previousCwd: string;
  let previousCodexGoals: string | undefined;
  let previousHome: string | undefined;
  let previousSettingsHome: string | undefined;
  let previousFetch: typeof fetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-settings-'));
    previousCwd = process.cwd();
    previousCodexGoals = process.env.CODEX_GOALS;
    previousHome = process.env.HOME;
    previousSettingsHome = process.env.EJCLAW_SETTINGS_HOME;
    previousFetch = globalThis.fetch;
    delete process.env.CODEX_GOALS;
    process.env.HOME = tempDir;
    process.env.EJCLAW_SETTINGS_HOME = tempDir;
    fs.mkdirSync(path.join(tempDir, '.codex'), { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
    if (previousCodexGoals === undefined) {
      delete process.env.CODEX_GOALS;
    } else {
      process.env.CODEX_GOALS = previousCodexGoals;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousSettingsHome === undefined) {
      delete process.env.EJCLAW_SETTINGS_HOME;
    } else {
      process.env.EJCLAW_SETTINGS_HOME = previousSettingsHome;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (value: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(value)).toString('base64');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
  }

  it('stores Codex goals in ~/.codex/config.toml [features]', () => {
    expect(getCodexFeatures()).toEqual({ goals: false });

    expect(updateCodexFeatures({ goals: true })).toEqual({ goals: true });
    expect(
      fs.readFileSync(path.join(tempDir, '.codex', 'config.toml'), 'utf-8'),
    ).toContain('goals = true');

    expect(updateCodexFeatures({ goals: false })).toEqual({ goals: false });
    expect(
      fs.readFileSync(path.join(tempDir, '.codex', 'config.toml'), 'utf-8'),
    ).toContain('goals = false');
  });

  it('still honors legacy CODEX_GOALS=true until migrated', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'CODEX_GOALS=true\n');
    expect(getCodexFeatures()).toEqual({ goals: true });

    updateCodexFeatures({ goals: false });
    expect(getCodexFeatures()).toEqual({ goals: false });
    expect(fs.readFileSync(path.join(tempDir, '.env'), 'utf-8')).not.toContain(
      'CODEX_GOALS',
    );
  });

  it('stores wham usage status and does not expose stale JWT expiry as live billing', async () => {
    const accountDir = path.join(tempDir, '.codex-accounts', '1');
    fs.mkdirSync(accountDir, { recursive: true });
    const staleJwt = fakeJwt({
      email: 'cached@example.com',
      sub: 'acct_cached',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'free',
        chatgpt_subscription_active_until: '2026-01-01T00:00:00.000Z',
        chatgpt_subscription_last_checked: '2026-01-01T00:00:00.000Z',
      },
    });
    fs.writeFileSync(
      path.join(accountDir, 'auth.json'),
      `${JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            id_token: staleJwt,
            refresh_token: 'refresh-token',
          },
        },
        null,
        2,
      )}\n`,
    );

    const resetAt = 1_779_300_000;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://auth.openai.com/oauth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'live-access',
            id_token: staleJwt,
            refresh_token: 'next-refresh-token',
          }),
          { status: 200 },
        );
      }
      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        return new Response(
          JSON.stringify({
            email: 'live@example.com',
            plan_type: 'pro',
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                limit_window_seconds: 18000,
                reset_after_seconds: 600,
                reset_at: resetAt,
                used_percent: 21,
              },
              secondary_window: {
                limit_window_seconds: 604800,
                reset_after_seconds: 3600,
                reset_at: resetAt + 600,
                used_percent: 7,
              },
            },
            rate_limit_reached_type: null,
            credits: {
              has_credits: false,
              overage_limit_reached: false,
              unlimited: false,
            },
            spend_control: { reached: false },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const refreshed = await refreshCodexAccount(1);

    expect(refreshed.planType).toBe('pro');
    expect(refreshed.email).toBe('live@example.com');
    expect(refreshed.subscriptionUntil).toBeNull();
    expect(refreshed.subscriptionSource).toBeNull();
    expect(refreshed.liveStatus).toMatchObject({
      source: 'wham/usage',
      planType: 'pro',
      rateLimit: {
        allowed: true,
        limitReached: false,
        primaryWindow: {
          limitWindowSeconds: 18000,
          resetAfterSeconds: 600,
          resetAt: new Date(resetAt * 1000).toISOString(),
          usedPercent: 21,
        },
      },
      credits: {
        hasCredits: false,
        overageLimitReached: false,
        unlimited: false,
      },
      spendControl: { reached: false },
    });

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(accountDir, 'plan-status.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 21 },
      },
    });
    expect(listCodexAccounts()[0]).toMatchObject({
      planType: 'pro',
      subscriptionUntil: null,
      liveStatus: { source: 'wham/usage' },
    });
  });
});
