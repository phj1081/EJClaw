import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardOverview } from './api';
import { messages } from './i18n';
import { SystemStatusStrip } from './SystemStatusStrip';

const t = messages.en;

function overview(
  overrides: Partial<DashboardOverview> = {},
): DashboardOverview {
  return {
    generatedAt: '2026-04-28T04:15:00.000Z',
    inbox: [],
    operations: { serviceRestarts: [] },
    rooms: { active: 0, inactive: 0, total: 0, waiting: 0 },
    services: [
      {
        activeRooms: 2,
        agentType: 'codex',
        assistantName: 'owner',
        serviceId: 'svc-owner',
        totalRooms: 3,
        updatedAt: '2026-04-28T04:14:00.000Z',
      },
    ],
    tasks: {
      active: 0,
      completed: 0,
      paused: 0,
      total: 0,
      watchers: { active: 0, completed: 0, paused: 0 },
    },
    usage: { fetchedAt: '2026-04-28T04:15:00.000Z', rows: [] },
    ...overrides,
  };
}

describe('SystemStatusStrip', () => {
  it('stays hidden when services and CI watchers are healthy', () => {
    const html = renderToStaticMarkup(
      createElement(SystemStatusStrip, { overview: overview(), t }),
    );

    expect(html).toBe('');
  });

  it('surfaces paused CI watchers as a room-level system warning', () => {
    const html = renderToStaticMarkup(
      createElement(SystemStatusStrip, {
        overview: overview({
          tasks: {
            active: 0,
            completed: 0,
            paused: 2,
            total: 2,
            watchers: { active: 0, completed: 0, paused: 2 },
          },
        }),
        t,
      }),
    );

    expect(html).toContain('system-status-strip');
    expect(html).toContain(t.health.ciFailures);
    expect(html).toContain('2');
  });

  it('surfaces stale and missing service heartbeat signals', () => {
    const staleHtml = renderToStaticMarkup(
      createElement(SystemStatusStrip, {
        overview: overview({
          services: [
            {
              activeRooms: 0,
              agentType: 'claude',
              assistantName: 'reviewer',
              serviceId: 'svc-reviewer',
              totalRooms: 1,
              updatedAt: '2026-04-28T03:58:00.000Z',
            },
          ],
        }),
        t,
      }),
    );
    const missingHtml = renderToStaticMarkup(
      createElement(SystemStatusStrip, {
        overview: overview({ services: [] }),
        t,
      }),
    );

    expect(staleHtml).toContain(t.health.levels.down);
    expect(missingHtml).toContain(t.service.empty);
  });
});
