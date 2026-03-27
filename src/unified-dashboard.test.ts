import { describe, expect, it } from 'vitest';

import type { UsageRow } from './dashboard-usage-rows.js';
import {
  formatStatusHeader,
  renderUsageTable,
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
