import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GlassesPanel } from './GlassesPanel';
import type { DashboardOverview, StatusSnapshot } from './api';

const overview: DashboardOverview = {
  generatedAt: '2026-06-07T13:00:00.000Z',
  services: [],
  rooms: {
    total: 1,
    active: 1,
    waiting: 0,
    inactive: 0,
  },
  tasks: {
    total: 1,
    active: 1,
    paused: 0,
    completed: 0,
    watchers: {
      active: 0,
      paused: 0,
      completed: 0,
    },
  },
  usage: {
    rows: [],
    fetchedAt: null,
  },
  inbox: [
    {
      createdAt: '2026-06-07T12:59:30.000Z',
      groupKey: 'task:review',
      id: 'inbox-1',
      kind: 'reviewer-request',
      lastOccurredAt: '2026-06-07T12:59:30.000Z',
      occurrences: 1,
      occurredAt: '2026-06-07T12:59:30.000Z',
      roomJid: 'dc:ops',
      roomName: 'Ops',
      severity: 'warn',
      source: 'paired-task',
      summary: 'Reviewer requested owner changes',
      taskId: 'task-1',
      taskStatus: 'active',
      title: 'Review follow-up',
    },
  ],
};

const snapshots: StatusSnapshot[] = [
  {
    agentType: 'codex',
    assistantName: 'Codex',
    serviceId: 'codex-main',
    updatedAt: '2026-06-07T13:00:00.000Z',
    entries: [
      {
        agentType: 'codex',
        elapsedMs: 12000,
        folder: 'ejclaw',
        jid: 'dc:ops',
        name: 'Ops',
        pendingMessages: false,
        pendingTasks: 1,
        status: 'processing',
      },
    ],
  },
];

describe('GlassesPanel', () => {
  it('renders a compact display queue and voice input surface', () => {
    const html = renderToStaticMarkup(
      createElement(GlassesPanel, {
        createRequestId: () => 'req-1',
        error: null,
        freshnessText: 'fresh',
        inboxActionKey: null,
        locale: 'ko',
        onInboxAction: async () => true,
        onRefresh: () => {},
        onSendRoomMessage: async () => true,
        overview,
        refreshing: false,
        roomMessageKey: null,
        snapshots,
      }),
    );

    expect(html).toContain('glasses-shell');
    expect(html).toContain('Review follow-up');
    expect(html).toContain('리뷰');
    expect(html).toContain('Voice');
  });

  it('tolerates partial status snapshot payloads while data is refreshing', () => {
    const html = renderToStaticMarkup(
      createElement(GlassesPanel, {
        createRequestId: () => 'req-1',
        error: null,
        freshnessText: 'fresh',
        inboxActionKey: null,
        locale: 'ko',
        onInboxAction: async () => true,
        onRefresh: () => {},
        onSendRoomMessage: async () => true,
        overview,
        refreshing: false,
        roomMessageKey: null,
        snapshots: [{} as StatusSnapshot],
      }),
    );

    expect(html).toContain('glasses-shell');
    expect(html).toContain('Review follow-up');
  });
});
