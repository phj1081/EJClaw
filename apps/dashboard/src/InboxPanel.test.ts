import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardOverview } from './api';
import { InboxPanel, type InboxPanelProps } from './InboxPanel';
import { messages } from './i18n';

const t = messages.en;

function overview(inbox: DashboardOverview['inbox']): DashboardOverview {
  return {
    generatedAt: '2026-04-28T04:00:00.000Z',
    inbox,
    operations: { serviceRestarts: [] },
    rooms: { active: 0, inactive: 0, total: 0, waiting: 0 },
    services: [],
    tasks: {
      active: 0,
      completed: 0,
      paused: 0,
      total: 0,
      watchers: { active: 0, completed: 0, paused: 0 },
    },
    usage: { fetchedAt: null, rows: [] },
  };
}

const inboxItem: DashboardOverview['inbox'][number] = {
  createdAt: '2026-04-28T03:55:00.000Z',
  groupFolder: 'eyejokerdb',
  groupKey: 'paired:room-1',
  id: 'inbox-1',
  kind: 'reviewer-request',
  lastOccurredAt: '2026-04-28T03:59:00.000Z',
  occurrences: 2,
  occurredAt: '2026-04-28T03:58:00.000Z',
  roomJid: 'room-1',
  roomName: 'eyejokerdb-main',
  severity: 'warn',
  source: 'paired-task',
  summary: '<internal>hidden</internal>Reviewer needs action',
  title: '<internal>hidden</internal>Review requested',
};

const baseProps: InboxPanelProps = {
  inboxActionKey: null,
  locale: 'en',
  onInboxAction: () => {},
  onTaskAction: () => {},
  overview: overview([inboxItem]),
  taskActionKey: null,
  tasks: [],
  t,
};

describe('InboxPanel', () => {
  it('renders inbox summary, filters, and paired task actions', () => {
    const html = renderToStaticMarkup(
      createElement(InboxPanel, { ...baseProps }),
    );

    expect(html).toContain(t.inbox.summary);
    expect(html).toContain('Review requested');
    expect(html).toContain('Reviewer needs action');
    expect(html).toContain(t.inbox.actions.runReview);
    expect(html).toContain(t.inbox.actions.decline);
    expect(html).toContain(t.inbox.actions.dismiss);
    expect(html).not.toContain('internal');
  });

  it('renders empty state when no inbox items exist', () => {
    const html = renderToStaticMarkup(
      createElement(InboxPanel, {
        ...baseProps,
        overview: overview([]),
      }),
    );

    expect(html).toContain(t.inbox.empty);
  });
});
