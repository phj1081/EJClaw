import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardRoomActivity } from './api';
import { messages } from './i18n';
import { RoomCardV2, type RoomEntryWithService } from './RoomCardV2';

const t = messages.ko;

const entry: RoomEntryWithService = {
  jid: 'room-1',
  name: 'eyejokerdb-main',
  folder: 'eyejokerdb',
  agentType: 'codex',
  status: 'inactive',
  elapsedMs: null,
  pendingMessages: false,
  pendingTasks: 0,
  serviceId: 'svc-1',
};

const formatters = {
  formatDate: (value: string | null | undefined) => value ?? '-',
  formatDuration: (value: number | null) => (value === null ? '-' : `${value}`),
  formatLiveElapsed: (value: number) => `${value}`,
  senderRoleClass: (value: string | null | undefined) =>
    (value ?? '').toLowerCase().includes('owner') ? 'role-owner' : 'role-human',
  statusLabel: (status: string) => status,
};

function activity(
  overrides: Partial<DashboardRoomActivity> = {},
): DashboardRoomActivity {
  return {
    serviceId: 'svc-1',
    jid: 'room-1',
    name: 'eyejokerdb-main',
    folder: 'eyejokerdb',
    agentType: 'codex',
    status: 'inactive',
    elapsedMs: null,
    pendingMessages: false,
    pendingTasks: 0,
    messages: [],
    pairedTask: null,
    ...overrides,
  };
}

describe('RoomCardV2', () => {
  it('renders an inactive room without activity', () => {
    const html = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: undefined,
        activityLoading: false,
        busy: false,
        draft: '',
        entry,
        expanded: false,
        inboxItems: [],
        locale: 'ko',
        onDraftChange: () => {},
        onSendMessage: () => {},
        onToggle: () => {},
        pinned: false,
        t,
        ...formatters,
      }),
    );

    expect(html).toContain('eyejokerdb-main');
    expect(html).toContain(t.rooms.noActivity);
  });

  it('renders regular bot messages in the expanded thread', () => {
    const html = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: activity({
          messages: [
            {
              id: 'bot-1',
              sender: 'bot-1',
              senderName: 'owner',
              content: 'TASK_DONE\n\nprod 배포 완료',
              timestamp: '2026-04-28T02:00:00.000Z',
              isFromMe: false,
              isBotMessage: true,
              sourceKind: 'bot',
            },
          ],
        }),
        activityLoading: false,
        busy: false,
        draft: '',
        entry,
        expanded: true,
        inboxItems: [],
        locale: 'ko',
        onDraftChange: () => {},
        onSendMessage: () => {},
        onToggle: () => {},
        pinned: true,
        t,
        ...formatters,
      }),
    );

    expect(html).toContain('TASK_DONE');
    expect(html).toContain('prod 배포 완료');
  });
});
