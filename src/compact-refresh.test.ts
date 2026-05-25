import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ejclaw-compact-refresh-test',
}));

import {
  clearCompactRefreshIfUnchanged,
  markCompactRefreshNeeded,
  maybeApplyCompactRefresh,
  readCompactRefreshFlag,
} from './compact-refresh.js';

const refreshDir = '/tmp/ejclaw-compact-refresh-test/compact-refresh';

describe('compact-refresh', () => {
  beforeEach(() => {
    fs.rmSync(refreshDir, { recursive: true, force: true });
  });

  it('marks and reads compact refresh flags by session folder', () => {
    const flag = markCompactRefreshNeeded({
      sessionFolder: 'room:reviewer',
      sessionId: 'session-1',
      trigger: 'auto',
    });

    expect(readCompactRefreshFlag('room:reviewer')).toMatchObject({
      sessionFolder: 'room:reviewer',
      sessionId: 'session-1',
      trigger: 'auto',
      compactedAt: flag.compactedAt,
    });
  });

  it('applies a one-shot compact refresh only for owner and reviewer roles', () => {
    const flag = markCompactRefreshNeeded({
      sessionFolder: 'room',
      sessionId: 'session-1',
    });

    const applied = maybeApplyCompactRefresh({
      sessionFolder: 'room',
      sessionId: 'session-1',
      role: 'owner',
      prompt: 'continue task',
    });

    expect(applied?.flag).toEqual(flag);
    expect(applied?.prompt).toContain('EJClaw compact refresh');
    expect(applied?.prompt).toContain('continue task');

    clearCompactRefreshIfUnchanged({
      sessionFolder: 'room',
      flag,
    });

    expect(readCompactRefreshFlag('room')).toBeNull();
  });

  it('does not apply to arbiter, compact commands, fresh sessions, or stale sessions', () => {
    markCompactRefreshNeeded({
      sessionFolder: 'room',
      sessionId: 'session-1',
    });

    expect(
      maybeApplyCompactRefresh({
        sessionFolder: 'room',
        sessionId: 'session-1',
        role: 'arbiter',
        prompt: 'judge',
      }),
    ).toBeNull();

    expect(
      maybeApplyCompactRefresh({
        sessionFolder: 'room',
        sessionId: 'session-1',
        role: 'owner',
        prompt: '/compact',
      }),
    ).toBeNull();

    expect(
      maybeApplyCompactRefresh({
        sessionFolder: 'room',
        role: 'owner',
        prompt: 'fresh',
      }),
    ).toBeNull();

    expect(
      maybeApplyCompactRefresh({
        sessionFolder: 'room',
        sessionId: 'different-session',
        role: 'owner',
        prompt: 'stale',
      }),
    ).toBeNull();
    expect(readCompactRefreshFlag('room')).toBeNull();
  });
});
