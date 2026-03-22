import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardOptions } from './dashboard-status-content.js';

function makeOptions(sessionId?: string): DashboardOptions {
  const sessions: Record<string, string> = sessionId
    ? { 'group-folder': sessionId }
    : {};

  return {
    assistantName: 'Test',
    channels: [],
    getSessions: () => sessions,
    queue: {
      getStatuses: () => [
        {
          jid: 'dc:123',
          status: 'inactive',
          elapsedMs: null,
          pendingMessages: false,
          pendingTasks: 0,
        },
      ],
    } as unknown as DashboardOptions['queue'],
    registeredGroups: () => ({
      'dc:123': {
        name: 'clone-test',
        folder: 'group-folder',
        trigger: '@bot',
        added_at: '2026-03-16T00:00:00.000Z',
      },
    }),
    statusChannelId: 'status',
    statusUpdateInterval: 60000,
    usageUpdateInterval: 60000,
  };
}

describe('buildStatusContent', () => {
  async function loadBuildStatusContent(
    statusShowRooms = 'true',
  ): Promise<(opts: DashboardOptions) => string> {
    vi.resetModules();
    process.env.STATUS_SHOW_ROOMS = statusShowRooms;
    const mod = await import('./dashboard-status-content.js');
    return mod.buildStatusContent;
  }

  afterEach(() => {
    delete process.env.STATUS_SHOW_ROOMS;
  });

  it('shows cleared sessions as empty', async () => {
    const buildStatusContent = await loadBuildStatusContent();
    const content = buildStatusContent(makeOptions());
    expect(content).toContain('세션 없음');
  });

  it('shows a shortened session id when a session exists', async () => {
    const buildStatusContent = await loadBuildStatusContent();
    const content = buildStatusContent(makeOptions('session-1234567890'));
    expect(content).toContain('세션 34567890');
  });

  it('returns an empty string when room status display is disabled', async () => {
    const buildStatusContent = await loadBuildStatusContent('false');
    expect(buildStatusContent(makeOptions())).toBe('');
  });
});
