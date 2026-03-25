import { describe, expect, it } from 'vitest';

import {
  buildCiWatchPrompt,
  DEFAULT_WATCH_CI_CONTEXT_MODE,
  DEFAULT_GITHUB_WATCH_CI_INTERVAL_SECONDS,
  normalizeWatchCiIntervalSeconds,
} from '../src/watch-ci.js';

describe('watch-ci helpers', () => {
  it('builds a self-cancelling CI watch prompt', () => {
    const prompt = buildCiWatchPrompt({
      taskId: 'task-123',
      target: 'PR #42 checks',
      checkInstructions:
        'Use gh pr checks 42 and summarize only terminal results.',
    });

    expect(prompt).toContain('PR #42 checks');
    expect(prompt).toContain('task-123');
    expect(prompt).toContain('cancel_task');
    expect(prompt).toContain('send_message');
    expect(prompt).toContain('gh pr checks 42');
    expect(prompt).toContain('CI 완료: <target>');
    expect(prompt).toContain('판정: <one-line conclusion>');
    expect(prompt).toContain(
      'Use the watch target and check instructions in this prompt as the source of truth',
    );
  });

  it('defaults CI watchers to isolated context', () => {
    expect(DEFAULT_WATCH_CI_CONTEXT_MODE).toBe('isolated');
  });

  it('normalizes valid poll intervals', () => {
    expect(normalizeWatchCiIntervalSeconds()).toBe(60);
    expect(normalizeWatchCiIntervalSeconds(30)).toBe(30);
    expect(normalizeWatchCiIntervalSeconds(600)).toBe(600);
    expect(
      normalizeWatchCiIntervalSeconds(undefined, { ciProvider: 'github' }),
    ).toBe(DEFAULT_GITHUB_WATCH_CI_INTERVAL_SECONDS);
    expect(normalizeWatchCiIntervalSeconds(10, { ciProvider: 'github' })).toBe(
      10,
    );
  });

  it('rejects invalid poll intervals', () => {
    expect(() => normalizeWatchCiIntervalSeconds(29)).toThrow(
      /between 30 and 3600/i,
    );
    expect(() => normalizeWatchCiIntervalSeconds(3601)).toThrow(
      /between 30 and 3600/i,
    );
    expect(() => normalizeWatchCiIntervalSeconds(30.5)).toThrow(/integer/i);
    expect(() =>
      normalizeWatchCiIntervalSeconds(9, { ciProvider: 'github' }),
    ).toThrow(/between 10 and 3600/i);
  });
});
