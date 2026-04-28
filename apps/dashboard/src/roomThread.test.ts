import { describe, expect, it } from 'vitest';

import type { DashboardRoomActivity } from './api';
import { buildRoomThreadEntries, isWatcherRoomMessage } from './roomThread';

type RoomMessage = DashboardRoomActivity['messages'][number];
type RoomOutput = NonNullable<
  DashboardRoomActivity['pairedTask']
>['outputs'][number];

function message(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: 'msg-1',
    sender: 'user-1',
    senderName: '눈쟁이',
    content: 'hello',
    timestamp: '2026-04-28T01:00:00.000Z',
    isFromMe: false,
    isBotMessage: false,
    sourceKind: 'human',
    ...overrides,
  };
}

function output(overrides: Partial<RoomOutput>): RoomOutput {
  return {
    id: 1,
    turnNumber: 1,
    role: 'owner',
    verdict: 'task_done',
    createdAt: '2026-04-28T01:02:00.000Z',
    outputText: 'TASK_DONE\n\nfinal output',
    ...overrides,
  };
}

describe('room thread entries', () => {
  it('keeps regular bot messages so Discord-visible outputs appear in rooms', () => {
    const entries = buildRoomThreadEntries({
      messages: [
        message({ id: 'human-1', content: '확인해줘' }),
        message({
          id: 'bot-1',
          sender: 'bot-1',
          senderName: '오너',
          content: 'TASK_DONE\n\nprod 배포 완료',
          timestamp: '2026-04-28T01:01:00.000Z',
          isBotMessage: true,
          sourceKind: 'bot',
        }),
      ],
      outputs: [],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['human-1', 'bot-1']);
    expect(entries.at(-1)).toMatchObject({
      senderName: '오너',
      content: 'TASK_DONE\n\nprod 배포 완료',
      sourceKind: 'bot',
    });
  });

  it('keeps watcher messages out of the main room thread', () => {
    const watcher = message({
      id: 'watcher-1',
      senderName: '리뷰어',
      content: 'CI 완료: PR #1 Quality Check',
      isBotMessage: true,
      sourceKind: 'bot',
    });

    expect(isWatcherRoomMessage(watcher)).toBe(true);
    expect(
      buildRoomThreadEntries({ messages: [watcher], outputs: [] }),
    ).toHaveLength(0);
  });

  it('deduplicates bot messages that are already present as paired outputs', () => {
    const entries = buildRoomThreadEntries({
      messages: [
        message({
          id: 'bot-duplicate',
          senderName: '오너',
          content: 'TASK_DONE\n\nfinal output',
          timestamp: '2026-04-28T01:02:30.000Z',
          isBotMessage: true,
          sourceKind: 'bot',
        }),
      ],
      outputs: [output({ id: 7 })],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'out:7',
      sourceKind: 'agent_output',
      turnNumber: 1,
    });
  });
});
