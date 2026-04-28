import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardOverview, StatusSnapshot } from './api';
import { messages, type Messages } from './i18n';
import { ServicePanel, type ServicePanelProps } from './ServicePanel';

const t = messages.en;

function formatDuration(value: number | null, t: Messages): string {
  if (value === null) return '-';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}${t.units.second}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${t.units.minute}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${t.units.hour} ${minutes % 60}${t.units.minute}`;
}

function overview(
  services: DashboardOverview['services'],
  overrides: Partial<DashboardOverview> = {},
): DashboardOverview {
  return {
    generatedAt: '2026-04-28T04:15:00.000Z',
    inbox: [],
    operations: { serviceRestarts: [] },
    rooms: { active: 0, inactive: 0, total: 0, waiting: 0 },
    services,
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

const snapshots: StatusSnapshot[] = [
  {
    agentType: 'codex',
    assistantName: 'owner',
    entries: [
      {
        agentType: 'codex',
        elapsedMs: null,
        folder: 'eyejokerdb',
        jid: 'room-1',
        name: 'eyejokerdb-main',
        pendingMessages: true,
        pendingTasks: 3,
        status: 'waiting',
      },
    ],
    serviceId: 'svc-owner',
    updatedAt: '2026-04-28T04:14:00.000Z',
  },
];

const baseProps: ServicePanelProps = {
  formatDuration,
  locale: 'en',
  onRestartStack: () => {},
  overview: overview(
    [
      {
        activeRooms: 2,
        agentType: 'codex',
        assistantName: 'owner',
        serviceId: 'svc-owner',
        totalRooms: 3,
        updatedAt: '2026-04-28T04:14:00.000Z',
      },
      {
        activeRooms: 0,
        agentType: 'claude',
        assistantName: 'reviewer',
        serviceId: 'svc-reviewer',
        totalRooms: 1,
        updatedAt: '2026-04-28T04:08:00.000Z',
      },
    ],
    {
      inbox: [
        {
          createdAt: '2026-04-28T04:10:00.000Z',
          groupFolder: 'eyejokerdb',
          groupKey: 'ci',
          id: 'ci-1',
          kind: 'ci-failure',
          lastOccurredAt: '2026-04-28T04:12:00.000Z',
          occurrences: 2,
          occurredAt: '2026-04-28T04:10:00.000Z',
          severity: 'error',
          source: 'status-snapshot',
          summary: 'CI failed',
          title: 'CI failed',
        },
      ],
      operations: {
        serviceRestarts: [
          {
            completedAt: null,
            id: 'restart-1',
            requestedAt: '2026-04-28T04:13:00.000Z',
            services: ['owner', 'reviewer'],
            status: 'running',
            target: 'stack',
          },
        ],
      },
    },
  ),
  serviceActionKey: null,
  snapshots,
  t,
};

describe('ServicePanel', () => {
  it('renders service health, queue signals, and restart log', () => {
    const html = renderToStaticMarkup(createElement(ServicePanel, baseProps));

    expect(html).toContain(t.health.levels.stale);
    expect(html).toContain(t.health.ciFailures);
    expect(html).toContain('2');
    expect(html).toContain('3');
    expect(html).toContain('reviewer');
    expect(html).toContain(t.health.restartLog);
    expect(html).toContain('owner, reviewer');
  });

  it('renders restart pending state and empty services state', () => {
    const html = renderToStaticMarkup(
      createElement(ServicePanel, {
        ...baseProps,
        overview: overview([]),
        serviceActionKey: 'stack:restart',
        snapshots: [],
      }),
    );

    expect(html).toContain(t.health.restarting);
    expect(html).toContain('disabled=""');
    expect(html).toContain(t.service.empty);
  });
});
