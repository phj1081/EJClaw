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

  it('deduplicates continuation chunks that are contained in a paired output', () => {
    const continuation =
      'PR 설명에 TaskPanel.tsx + statusLabel 이동+테스트 2개 모두 명시되어 있고 검증도 완료됐습니다.';
    const entries = buildRoomThreadEntries({
      messages: [
        message({
          id: 'bot-continuation',
          senderName: '리뷰어',
          content: continuation,
          timestamp: '2026-04-28T01:02:30.000Z',
          isBotMessage: true,
          sourceKind: 'bot',
        }),
      ],
      outputs: [
        output({
          id: 8,
          role: '리뷰어',
          outputText: `STEP_DONE\n\n파일 검증 완료\n\n${continuation}\n\n다음 슬라이스 권고`,
        }),
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'out:8',
      senderName: '리뷰어',
      sourceKind: 'agent_output',
    });
  });

  it('merges adjacent bot chunks from the same sender', () => {
    const entries = buildRoomThreadEntries({
      messages: [
        message({
          id: 'reviewer-1',
          senderName: '리뷰어',
          content: 'STEP_DONE — PR #63 검증 완료\n\n파일 검증',
          timestamp: '2026-04-28T01:02:00.000Z',
          isBotMessage: true,
          sourceKind: 'bot',
        }),
        message({
          id: 'reviewer-2',
          senderName: '리뷰어',
          content: 'PR 설명에 추출 모듈 전부 명시\n\n다음 슬라이스 권고',
          timestamp: '2026-04-28T01:02:03.000Z',
          isBotMessage: true,
          sourceKind: 'bot',
        }),
      ],
      outputs: [],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'reviewer-1+reviewer-2',
      senderName: '리뷰어',
      sourceKind: 'bot',
    });
    expect(entries[0].content).toContain('파일 검증');
    expect(entries[0].content).toContain('다음 슬라이스 권고');
  });

  it('keeps adjacent human messages separate', () => {
    const entries = buildRoomThreadEntries({
      messages: [
        message({
          id: 'human-1',
          content: '첫 번째 요청',
          timestamp: '2026-04-28T01:02:00.000Z',
        }),
        message({
          id: 'human-2',
          content: '두 번째 요청',
          timestamp: '2026-04-28T01:02:03.000Z',
        }),
      ],
      outputs: [],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['human-1', 'human-2']);
  });

  it('keeps adjacent bot status outputs separate', () => {
    const entries = buildRoomThreadEntries({
      messages: [
        message({
          id: 'reviewer-status-1',
          senderName: '리뷰어',
          content: 'STEP_DONE — PR #63 검증 완료',
          timestamp: '2026-04-28T01:02:00.000Z',
          isBotMessage: true,
          sourceKind: 'bot',
        }),
        message({
          id: 'reviewer-status-2',
          senderName: '리뷰어',
          content: 'STEP_DONE — PR #64 검증 완료',
          timestamp: '2026-04-28T01:02:03.000Z',
          isBotMessage: true,
          sourceKind: 'bot',
        }),
      ],
      outputs: [],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'reviewer-status-1',
      'reviewer-status-2',
    ]);
  });
});
