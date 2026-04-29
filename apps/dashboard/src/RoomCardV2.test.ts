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
  senderRoleClass: (value: string | null | undefined) => {
    const role = (value ?? '').toLowerCase();
    if (role.includes('owner')) return 'role-owner';
    if (role.includes('reviewer')) return 'role-reviewer';
    if (role.includes('arbiter')) return 'role-arbiter';
    return 'role-human';
  },
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

  it('uses canonical room messages for collapsed previews when outputs are empty', () => {
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
          pairedTask: {
            id: 'task-1',
            title: 'Deploy production',
            status: 'completed',
            roundTripCount: 1,
            updatedAt: '2026-04-28T02:01:00.000Z',
            currentTurn: null,
            outputs: [],
          },
        }),
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

    expect(html).toContain('TASK_DONE');
    expect(html).toContain('prod 배포 완료');
    expect(html).not.toContain(t.rooms.noActivity);
  });

  it('localizes protocol role and verdict labels in Korean rooms', () => {
    const html = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: activity({
          pairedTask: {
            id: 'task-1',
            title: 'Review pending',
            status: 'in_review',
            roundTripCount: 2,
            updatedAt: '2026-04-28T02:03:00.000Z',
            currentTurn: null,
            outputs: [
              {
                id: 1,
                turnNumber: 2,
                role: 'reviewer',
                verdict: 'continue',
                createdAt: '2026-04-28T02:02:00.000Z',
                outputText: '검증 완료. 다음 단계로 진행 가능합니다.',
              },
            ],
          },
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

    expect(html).toContain('>리뷰어</span>');
    expect(html).toContain('>계속</span>');
    expect(html).not.toContain('>reviewer</span>');
    expect(html).not.toContain('>continue</span>');
  });

  it('renders live progress as markdown', () => {
    const html = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: activity({
          pairedTask: {
            id: 'task-1',
            title: 'OpenAPI sync',
            status: 'running',
            roundTripCount: 1,
            updatedAt: '2026-04-28T02:01:00.000Z',
            currentTurn: {
              turnId: 'turn-1',
              role: 'owner',
              intentKind: 'implementation',
              state: 'running',
              attemptNo: 1,
              executorServiceId: 'svc-1',
              executorAgentType: 'codex',
              activeRunId: null,
              createdAt: '2026-04-28T02:00:00.000Z',
              updatedAt: '2026-04-28T02:01:00.000Z',
              completedAt: null,
              lastError: null,
              progressText:
                '최신 `origin/dev`로 fast-forward한 뒤 `pnpm openapi:sync`를 실행합니다.',
              progressUpdatedAt: '2026-04-28T02:01:00.000Z',
            },
            outputs: [],
          },
        }),
        activityLoading: false,
        busy: false,
        draft: '',
        entry: { ...entry, status: 'processing' },
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

    expect(html).toContain('class="live-progress"');
    expect(html).toContain('<code>origin/dev</code>');
    expect(html).toContain('<code>pnpm openapi:sync</code>');
    expect(html).not.toContain('`origin/dev`');
  });
});

describe('RoomCardV2 room thread details', () => {
  it('does not render site-only active turn placeholders without visible progress', () => {
    const pairedTask: NonNullable<DashboardRoomActivity['pairedTask']> = {
      id: 'task-1',
      title: 'OpenAPI sync',
      status: 'running',
      roundTripCount: 1,
      updatedAt: '2026-04-28T02:01:00.000Z',
      currentTurn: {
        turnId: 'turn-1',
        role: 'owner',
        intentKind: 'implementation',
        state: 'running',
        attemptNo: 1,
        executorServiceId: 'svc-1',
        executorAgentType: 'codex',
        activeRunId: 'run-site-only',
        createdAt: '2026-04-28T02:00:00.000Z',
        updatedAt: '2026-04-28T02:01:00.000Z',
        completedAt: null,
        lastError: null,
        progressText: null,
        progressUpdatedAt: null,
      },
      outputs: [],
    };

    const collapsed = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: activity({ pairedTask }),
        activityLoading: false,
        busy: false,
        draft: '',
        entry: { ...entry, status: 'processing' },
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
    const expanded = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: activity({ pairedTask }),
        activityLoading: false,
        busy: false,
        draft: '',
        entry: { ...entry, status: 'processing' },
        expanded: true,
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

    expect(collapsed).not.toContain('class="room-live"');
    expect(expanded).not.toContain('room-timeline-live');
    expect(expanded).not.toContain(t.rooms.loadingActivity);
    expect(expanded).toContain(t.rooms.noActivity);
  });

  it('renders message attachments as dashboard images', () => {
    const html = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: activity({
          messages: [
            {
              id: 'bot-attachment',
              sender: 'bot-1',
              senderName: 'owner',
              content: '라벨 좌측 클리핑 회귀 수정했습니다.',
              timestamp: '2026-04-28T02:00:00.000Z',
              isFromMe: false,
              isBotMessage: true,
              sourceKind: 'bot',
              attachments: [
                {
                  path: '/tmp/bar-chart-label-fit-playwright.png',
                  name: 'bar-chart-label-fit-playwright.png',
                  mime: 'image/png',
                },
              ],
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

    expect(html).toContain('class="room-attachments"');
    expect(html).toContain(
      '/api/attachments?path=%2Ftmp%2Fbar-chart-label-fit-playwright.png',
    );
    expect(html).toContain('bar-chart-label-fit-playwright.png');
  });

  it('renders expanded watcher messages without truncating content', () => {
    const watcherTail = 'WATCHER_TAIL_VISIBLE';
    const html = renderToStaticMarkup(
      createElement(RoomCardV2, {
        activity: activity({
          messages: [
            {
              id: 'watcher-1',
              sender: 'bot-1',
              senderName: 'reviewer',
              content: `[Watcher] ${'검증 로그 '.repeat(40)} ${watcherTail}`,
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

    expect(html).toContain('class="room-watcher-fold"');
    expect(html).toContain('>리뷰어</strong>');
    expect(html).toContain(watcherTail);
  });
});
