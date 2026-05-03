import { describe, expect, it } from 'vitest';

import type { UsageRow } from './dashboard-usage-rows.js';
import {
  buildWebUsageRowsForSnapshot,
  formatStatusHeader,
  getDashboardDuplicateCleanupIntervalMs,
  renderUsageTable,
  shouldPurgeDashboardChannelOnStart,
  summarizeWatcherTasks,
} from './unified-dashboard.js';

describe('summarizeWatcherTasks', () => {
  it('counts active and paused watcher tasks only', () => {
    const summary = summarizeWatcherTasks([
      {
        prompt:
          '[BACKGROUND CI WATCH]\n\nWatch target:\nGitHub Actions run 1\n\nCheck instructions:\na',
        status: 'active',
      },
      {
        prompt:
          '[BACKGROUND CI WATCH]\n\nWatch target:\nGitHub Actions run 2\n\nCheck instructions:\nb',
        status: 'paused',
      },
      {
        prompt:
          '[BACKGROUND CI WATCH]\n\nWatch target:\nGitHub Actions run 3\n\nCheck instructions:\nc',
        status: 'completed',
      },
      {
        prompt: 'normal scheduled task',
        status: 'active',
      },
    ]);

    expect(summary).toEqual({
      active: 1,
      paused: 1,
    });
  });
});

describe('formatStatusHeader', () => {
  it('shows active watcher count in the dashboard header', () => {
    expect(
      formatStatusHeader({
        totalActive: 3,
        totalRooms: 8,
        watchers: { active: 2, paused: 0 },
      }),
    ).toBe('**📊 에이전트 상태** — 활성 3 / 8 | 감시 2');
  });

  it('adds paused watcher count only when present', () => {
    expect(
      formatStatusHeader({
        totalActive: 3,
        totalRooms: 8,
        watchers: { active: 2, paused: 1 },
      }),
    ).toBe('**📊 에이전트 상태** — 활성 3 / 8 | 감시 2 | 일시정지 1');
  });
});

describe('shouldPurgeDashboardChannelOnStart', () => {
  it('purges on startup when explicitly requested, even with a stored message id', () => {
    expect(
      shouldPurgeDashboardChannelOnStart({
        purgeOnStart: true,
        storedMessageId: 'status-message-1',
      }),
    ).toBe(true);
  });

  it('does not purge when startup purge is disabled', () => {
    expect(
      shouldPurgeDashboardChannelOnStart({
        purgeOnStart: false,
        storedMessageId: null,
      }),
    ).toBe(false);
  });
});

describe('getDashboardDuplicateCleanupIntervalMs', () => {
  it('polls duplicate cleanup faster than the status update interval', () => {
    expect(getDashboardDuplicateCleanupIntervalMs(10_000)).toBe(2_000);
    expect(getDashboardDuplicateCleanupIntervalMs(1_000)).toBe(1_000);
  });
});

describe('renderUsageTable', () => {
  const claudeRow: UsageRow = {
    name: 'Claude pro',
    h5pct: 50,
    h5reset: '',
    d7pct: 30,
    d7reset: '',
  };
  const codexRow: UsageRow = {
    name: 'Codex',
    h5pct: 40,
    h5reset: '',
    d7pct: 25,
    d7reset: '',
  };

  it('renders Claude before separator before Codex', () => {
    const lines = renderUsageTable([claudeRow], [codexRow]);

    const claudeIdx = lines.findIndex((l) => l.includes('Claude'));
    const sepIdx = lines.findIndex((l) => /^─+$/.test(l));
    const codexIdx = lines.findIndex((l) => l.includes('Codex'));

    expect(claudeIdx).toBeGreaterThan(-1);
    expect(sepIdx).toBeGreaterThan(claudeIdx);
    expect(codexIdx).toBeGreaterThan(sepIdx);
  });

  it('omits separator when only Claude rows exist', () => {
    const lines = renderUsageTable([claudeRow], []);

    expect(lines.some((l) => /^─+$/.test(l))).toBe(false);
    expect(lines.some((l) => l.includes('Claude'))).toBe(true);
  });

  it('omits separator when only Codex rows exist', () => {
    const lines = renderUsageTable([], [codexRow]);

    expect(lines.some((l) => /^─+$/.test(l))).toBe(false);
    expect(lines.some((l) => l.includes('Codex'))).toBe(true);
  });

  it('returns fallback text when both groups are empty', () => {
    const lines = renderUsageTable([], []);
    expect(lines).toEqual(['_조회 불가_']);
  });
});

describe('buildWebUsageRowsForSnapshot', () => {
  it('keeps real Claude and Kimi rows ahead of Codex rows for web snapshots', () => {
    const rows = buildWebUsageRowsForSnapshot({
      serviceAgentType: 'claude-code',
      claudeAccounts: [
        {
          index: 0,
          masked: 'claude-1',
          isActive: true,
          isRateLimited: false,
          usage: {
            five_hour: {
              utilization: 0.2,
              resets_at: '2026-04-26T12:00:00.000Z',
            },
            seven_day: {
              utilization: 0.4,
              resets_at: '2026-04-27T12:00:00.000Z',
            },
          },
        },
        {
          index: 1,
          masked: 'claude-2',
          isActive: false,
          isRateLimited: false,
          usage: {
            five_hour: {
              utilization: 0.3,
              resets_at: '2026-04-26T12:00:00.000Z',
            },
            seven_day: {
              utilization: 0.5,
              resets_at: '2026-04-27T12:00:00.000Z',
            },
          },
        },
      ],
      kimiUsage: {
        fiveHour: { pct: 18, resetTime: '2026-04-26T12:00:00.000Z' },
        weekly: { pct: 29, resetTime: '2026-04-27T12:00:00.000Z' },
      },
      codexRows: [
        {
          name: 'Codex1',
          h5pct: 25,
          h5reset: '1h',
          d7pct: 35,
          d7reset: '2d',
        },
      ],
    });

    const names = rows.map((row) => row.name);
    expect(names[0]).toMatch(/^Claude1/);
    expect(names[1]).toMatch(/^Claude2/);
    expect(names[2]).toMatch(/^Kimi/);
    expect(names[3]).toBe('Codex1');
  });

  it('does not invent Claude or Kimi rows for codex-only services', () => {
    const rows = buildWebUsageRowsForSnapshot({
      serviceAgentType: 'codex',
      claudeAccounts: [
        {
          index: 0,
          masked: 'claude-1',
          isActive: true,
          isRateLimited: false,
          usage: null,
        },
      ],
      kimiUsage: {
        fiveHour: { pct: 18, resetTime: '2026-04-26T12:00:00.000Z' },
        weekly: { pct: 29, resetTime: '2026-04-27T12:00:00.000Z' },
      },
      codexRows: [
        {
          name: 'Codex1',
          h5pct: 25,
          h5reset: '1h',
          d7pct: 35,
          d7reset: '2d',
        },
      ],
    });

    expect(rows.map((row) => row.name)).toEqual(['Codex1']);
  });
});
