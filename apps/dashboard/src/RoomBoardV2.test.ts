import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardRoomActivity, StatusSnapshot } from './api';
import { messages } from './i18n';
import { RoomBoardV2, type RoomBoardV2Props } from './RoomBoardV2';

const t = messages.ko;

const snapshot: StatusSnapshot = {
  serviceId: 'svc-1',
  assistantName: 'codex',
  agentType: 'codex',
  updatedAt: '2026-04-28T04:00:00.000Z',
  entries: [
    {
      jid: 'room-1',
      name: 'eyejokerdb-main',
      folder: 'eyejokerdb',
      agentType: 'codex',
      status: 'processing',
      elapsedMs: 180_000,
      pendingMessages: false,
      pendingTasks: 3,
    },
  ],
};

const activity: DashboardRoomActivity = {
  serviceId: 'svc-1',
  jid: 'room-1',
  name: 'eyejokerdb-main',
  folder: 'eyejokerdb',
  agentType: 'codex',
  status: 'processing',
  elapsedMs: 180_000,
  pendingMessages: false,
  pendingTasks: 3,
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
  pairedTask: null,
};

const baseProps: RoomBoardV2Props = {
  createRequestId: () => 'request-1',
  formatDate: (value) => value ?? '-',
  formatDuration: (value) => (value === null ? '-' : `${value}`),
  formatLiveElapsed: (value) => `${value}`,
  inbox: [],
  locale: 'ko',
  onSelectedJidChange: () => {},
  onSendRoomMessage: async () => true,
  pendingMessages: {},
  roomActivity: { 'room-1': activity },
  roomActivityLoading: false,
  roomMessageKey: null,
  selectedJid: 'room-1',
  senderRoleClass: (value) =>
    (value ?? '').toLowerCase().includes('owner') ? 'role-owner' : 'role-human',
  snapshots: [snapshot],
  statusLabel: (status) => status,
  t,
};

describe('RoomBoardV2', () => {
  it('renders room list and selected detail thread', () => {
    const html = renderToStaticMarkup(createElement(RoomBoardV2, baseProps));

    expect(html).toContain('eyejokerdb-main');
    expect(html).toContain('TASK_DONE');
    expect(html).toContain('prod 배포 완료');
  });

  it('surfaces merge approval items as room action badges', () => {
    const html = renderToStaticMarkup(
      createElement(RoomBoardV2, {
        ...baseProps,
        inbox: [
          {
            id: 'paired:merge-1:merge_ready',
            groupKey: 'paired:merge-1:merge_ready',
            kind: 'approval',
            severity: 'warn',
            title: 'Ready to merge',
            summary: 'merge_ready',
            occurredAt: '2026-04-28T04:00:00.000Z',
            lastOccurredAt: '2026-04-28T04:00:00.000Z',
            createdAt: '2026-04-28T04:00:00.000Z',
            occurrences: 1,
            source: 'paired-task',
            roomJid: 'room-1',
            taskId: 'merge-1',
            taskStatus: 'merge_ready',
          },
        ],
      }),
    );

    expect(html).toContain(t.inbox.kinds.approval);
    expect(html).toContain('room-inbox-pip sev-warn');
    expect(html).toContain('rooms-list-bell sev-warn');
  });

  it('renders an empty state without snapshots', () => {
    const html = renderToStaticMarkup(
      createElement(RoomBoardV2, { ...baseProps, snapshots: [] }),
    );

    expect(html).toContain(t.rooms.empty);
  });
});
