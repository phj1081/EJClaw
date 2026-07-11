import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeUsageData } from './claude-usage.js';

const mocks = vi.hoisted(() => ({
  allTokens: [] as Array<{
    index: number;
    token: string;
    masked: string;
    isActive: boolean;
    isRateLimited: boolean;
  }>,
  configuredTokens: [] as string[],
  currentToken: undefined as string | undefined,
  currentTokenIndex: null as number | null,
  credentials: new Map<string, unknown>(),
  diskCache: {} as Record<string, unknown>,
  fetch: vi.fn(),
  forceRefreshToken: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  default: {
    existsSync: (filePath: string) => mocks.credentials.has(String(filePath)),
  },
}));

vi.mock('os', () => ({
  default: {
    homedir: () => '/test-home',
  },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/test-data',
}));

vi.mock('./logger.js', () => ({
  logger: mocks.logger,
}));

vi.mock('./token-refresh.js', () => ({
  forceRefreshToken: mocks.forceRefreshToken,
}));

vi.mock('./token-rotation.js', () => ({
  getAllTokens: () => mocks.allTokens,
  getConfiguredClaudeTokens: () => mocks.configuredTokens,
  getCurrentToken: () => mocks.currentToken,
  getCurrentTokenIndex: () => mocks.currentTokenIndex,
}));

vi.mock('./utils.js', () => ({
  readJsonFile: (filePath: string) =>
    filePath === '/test-data/claude-usage-cache.json'
      ? mocks.diskCache
      : mocks.credentials.get(filePath),
  writeJsonFile: (_filePath: string, value: Record<string, unknown>) => {
    mocks.diskCache = structuredClone(value);
  },
}));

function credentialsPath(accountIndex: number): string {
  return accountIndex === 0
    ? '/test-home/.claude/.credentials.json'
    : `/test-home/.claude-accounts/${accountIndex}/.credentials.json`;
}

function configureAccount(envToken = 'environment-value-BBBB2222'): void {
  mocks.allTokens = [
    {
      index: 0,
      token: envToken,
      masked: 'account-1',
      isActive: true,
      isRateLimited: false,
    },
  ];
  mocks.configuredTokens = [envToken];
}

function setCredentials(
  accountIndex: number,
  oauth: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
  },
): void {
  mocks.credentials.set(credentialsPath(accountIndex), {
    claudeAiOauth: oauth,
  });
}

function usageResponse(status = 200): Response {
  return new Response(
    status === 200
      ? JSON.stringify({
          five_hour: {
            utilization: 45.2,
            resets_at: '2026-07-12T12:00:00Z',
          },
        })
      : undefined,
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function authorizationForCall(callIndex: number): string | undefined {
  const init = mocks.fetch.mock.calls[callIndex]?.[1] as
    | RequestInit
    | undefined;
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

async function loadClaudeUsage() {
  return import('./claude-usage.js');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-12T00:00:00Z'));
  mocks.allTokens = [];
  mocks.configuredTokens = [];
  mocks.currentToken = undefined;
  mocks.currentTokenIndex = null;
  mocks.credentials.clear();
  mocks.diskCache = {};
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ClaudeUsageData', () => {
  it('represents partial API response data', () => {
    const data: ClaudeUsageData = {
      five_hour: { utilization: 10, resets_at: '2026-07-12T12:00:00Z' },
    };
    expect(data.five_hour?.utilization).toBe(10);
    expect(data.seven_day).toBeUndefined();
  });

  it('keeps account cache keys ahead of token suffix fallbacks', async () => {
    const { getUsageCacheReadKeys, getUsageCacheWriteKey } =
      await loadClaudeUsage();

    expect(
      getUsageCacheReadKeys(
        'environment-value-BBBB2222',
        0,
        'credential-value-AAAA1111',
      ),
    ).toEqual(['account-0', 'AAAA1111', 'BBBB2222']);
    expect(getUsageCacheWriteKey('environment-value-BBBB2222', 0)).toBe(
      'account-0',
    );
  });
});

describe('Claude usage bearer selection and cooldowns', () => {
  it('uses a non-expired credentials access token before the env token', async () => {
    configureAccount();
    setCredentials(0, {
      accessToken: 'credential-value-AAAA1111',
      expiresAt: Date.now() + 60_000,
    });
    mocks.fetch.mockResolvedValueOnce(usageResponse());
    const { fetchAllClaudeUsage } = await loadClaudeUsage();

    const result = await fetchAllClaudeUsage();

    expect(result[0]?.usage?.five_hour?.utilization).toBe(45.2);
    expect(authorizationForCall(0)).toBe('Bearer credential-value-AAAA1111');
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      { account: 1, source: 'credentials' },
      'Claude usage API: selected bearer token',
    );
  });

  it('falls back to the env token when credentials are expired', async () => {
    configureAccount();
    setCredentials(0, {
      accessToken: 'credential-value-AAAA1111',
      expiresAt: Date.now() - 1,
    });
    mocks.fetch.mockResolvedValueOnce(usageResponse());
    const { fetchAllClaudeUsage } = await loadClaudeUsage();

    await fetchAllClaudeUsage();

    expect(authorizationForCall(0)).toBe('Bearer environment-value-BBBB2222');
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      { account: 1, source: 'env' },
      'Claude usage API: selected bearer token',
    );
  });

  it('uses the credentials token for profile fetches too', async () => {
    configureAccount();
    setCredentials(0, {
      accessToken: 'credential-value-AAAA1111',
      expiresAt: Date.now() + 60_000,
    });
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          account: { email: 'account@example.test', has_claude_pro: true },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const { fetchAllClaudeProfiles } = await loadClaudeUsage();

    await fetchAllClaudeProfiles();

    expect(authorizationForCall(0)).toBe('Bearer credential-value-AAAA1111');
  });

  it('refreshes once after a 401 and retries immediately', async () => {
    configureAccount();
    mocks.fetch
      .mockResolvedValueOnce(usageResponse(401))
      .mockResolvedValueOnce(usageResponse());
    mocks.forceRefreshToken.mockResolvedValueOnce('refreshed-value-CCCC3333');
    const { fetchAllClaudeUsage } = await loadClaudeUsage();

    const result = await fetchAllClaudeUsage();

    expect(mocks.forceRefreshToken).toHaveBeenCalledTimes(1);
    expect(mocks.forceRefreshToken).toHaveBeenCalledWith(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(authorizationForCall(1)).toBe('Bearer refreshed-value-CCCC3333');
    expect(result[0]?.usage?.five_hour?.utilization).toBe(45.2);
  });

  it('limits refresh attempts to once per account every 10 minutes', async () => {
    configureAccount();
    mocks.fetch
      .mockResolvedValueOnce(usageResponse(401))
      .mockResolvedValueOnce(usageResponse())
      .mockResolvedValueOnce(usageResponse(401));
    mocks.forceRefreshToken.mockResolvedValueOnce('refreshed-value-CCCC3333');
    const { fetchAllClaudeUsage } = await loadClaudeUsage();

    await fetchAllClaudeUsage();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await fetchAllClaudeUsage();

    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.forceRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not fetch again during the 401 cooldown', async () => {
    configureAccount();
    mocks.fetch.mockResolvedValueOnce(usageResponse(401));
    mocks.forceRefreshToken.mockResolvedValueOnce(null);
    const { fetchAllClaudeUsage } = await loadClaudeUsage();

    await fetchAllClaudeUsage();
    await fetchAllClaudeUsage();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.forceRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not fetch again during the 429 cooldown', async () => {
    configureAccount();
    mocks.fetch.mockResolvedValueOnce(usageResponse(429));
    const { fetchAllClaudeUsage } = await loadClaudeUsage();

    await fetchAllClaudeUsage();
    await fetchAllClaudeUsage();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.forceRefreshToken).not.toHaveBeenCalled();
  });
});
