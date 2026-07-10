import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env.js', async () => {
  const actual = await vi.importActual<typeof import('./env.js')>('./env.js');
  return {
    ...actual,
    getEnv: (key: string) => {
      if (key === 'MOA_KIMI_API_KEY') return 'redacted';
      if (key === 'MOA_KIMI_BASE_URL') return 'https://api.kimi.test/coding';
      return actual.getEnv(key);
    },
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { fetchKimiUsage, resetKimiUsageCache } from './kimi-usage.js';

function successfulUsageResponse(): Response {
  return Response.json({
    user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
    usage: {
      limit: '100',
      used: '25',
      resetTime: '2026-07-18T00:00:00.000Z',
    },
    limits: [
      {
        detail: {
          limit: '100',
          used: '40',
          resetTime: '2026-07-11T05:00:00.000Z',
        },
      },
    ],
  });
}

function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('Kimi usage failure backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    resetKimiUsageCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('progresses through 1, 2, 4, 8, then 15 minute retry delays', async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValue(new Error('network unavailable'));

    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advanceClock(59_999);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advanceClock(1);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    advanceClock(119_999);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    advanceClock(1);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    advanceClock(239_999);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    advanceClock(1);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    advanceClock(479_999);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    advanceClock(1);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(5);

    advanceClock(899_999);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    advanceClock(1);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('resets the failure delay after a successful fetch', async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(successfulUsageResponse())
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(successfulUsageResponse());

    await fetchKimiUsage();
    advanceClock(60_000);
    const recovered = await fetchKimiUsage();

    expect(recovered).toEqual(
      expect.objectContaining({
        fiveHour: expect.objectContaining({ pct: 40 }),
        weekly: expect.objectContaining({ pct: 25 }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    advanceClock(5 * 60_000);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    advanceClock(59_999);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    advanceClock(1);
    await fetchKimiUsage();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
