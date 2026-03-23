import { describe, expect, it, vi } from 'vitest';

import type { ClaudeAccountUsage } from './claude-usage.js';

vi.mock('./claude-usage.js', () => ({
  fetchAllClaudeUsage: vi.fn(),
  fetchAllClaudeProfiles: vi.fn(),
  getClaudeProfile: (index: number) =>
    index === 0
      ? { email: 'a@example.com', planType: 'max' }
      : { email: 'b@example.com', planType: 'pro' },
}));

vi.mock('./codex-token-rotation.js', () => ({
  getAllCodexAccounts: () => [],
  updateCodexAccountUsage: vi.fn(),
}));

import {
  buildClaudeUsageRows,
  mergeClaudeDashboardAccounts,
} from './unified-dashboard.js';

describe('unified dashboard Claude usage rows', () => {
  it('keeps both Claude accounts visible when one account usage is unavailable', () => {
    const rows = buildClaudeUsageRows([
      {
        index: 0,
        masked: 'tok-a',
        isActive: true,
        isRateLimited: false,
        usage: {
          five_hour: {
            utilization: 0.4,
            resets_at: '2026-03-24T04:00:00+09:00',
          },
          seven_day: {
            utilization: 0.7,
            resets_at: '2026-03-29T04:00:00+09:00',
          },
        },
      },
      {
        index: 1,
        masked: 'tok-b',
        isActive: false,
        isRateLimited: true,
        usage: null,
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Claude1* max',
      h5pct: 40,
      d7pct: 70,
    });
    expect(rows[1]).toMatchObject({
      name: 'Claude2! pro',
      h5pct: -1,
      d7pct: -1,
    });
  });

  it('preserves the last successful usage per account instead of collapsing to one cache entry', () => {
    const cachedAccounts: ClaudeAccountUsage[] = [
      {
        index: 0,
        masked: 'tok-a',
        isActive: false,
        isRateLimited: false,
        usage: {
          five_hour: {
            utilization: 0.25,
            resets_at: '2026-03-24T04:00:00+09:00',
          },
          seven_day: {
            utilization: 0.5,
            resets_at: '2026-03-29T04:00:00+09:00',
          },
        },
      },
      {
        index: 1,
        masked: 'tok-b',
        isActive: true,
        isRateLimited: false,
        usage: {
          five_hour: {
            utilization: 0.6,
            resets_at: '2026-03-24T06:00:00+09:00',
          },
          seven_day: {
            utilization: 0.8,
            resets_at: '2026-03-30T04:00:00+09:00',
          },
        },
      },
    ];
    const liveAccounts: ClaudeAccountUsage[] = [
      {
        index: 0,
        masked: 'tok-a',
        isActive: true,
        isRateLimited: false,
        usage: null,
      },
      {
        index: 1,
        masked: 'tok-b',
        isActive: false,
        isRateLimited: true,
        usage: {
          five_hour: {
            utilization: 0.9,
            resets_at: '2026-03-24T08:00:00+09:00',
          },
          seven_day: {
            utilization: 0.95,
            resets_at: '2026-03-31T04:00:00+09:00',
          },
        },
      },
    ];

    const merged = mergeClaudeDashboardAccounts(liveAccounts, cachedAccounts);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      index: 0,
      isActive: true,
      usage: cachedAccounts[0].usage,
    });
    expect(merged[1]).toMatchObject({
      index: 1,
      isRateLimited: true,
      usage: liveAccounts[1].usage,
    });
  });
});
