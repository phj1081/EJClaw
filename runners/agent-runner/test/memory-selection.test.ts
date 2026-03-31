import { describe, expect, it } from 'vitest';

import { selectCompactMemoriesFromSummary } from '../src/memory-selection.js';

describe('memory selection', () => {
  it('keeps stable room memories and drops transient status lines', () => {
    const selected = selectCompactMemoriesFromSummary(
      [
        '방 메모리는 새 세션 시작 시에만 주입한다.',
        '테스트 599개 통과.',
        '사용자는 수동 명령보다 자동 기억 형성을 원한다.',
      ].join(' '),
      'room:ejclaw',
    );

    expect(selected).toHaveLength(2);
    expect(selected[0].content).toBe('방 메모리는 새 세션 시작 시에만 주입한다.');
    expect(selected[0].memoryKind).toBe('room_norm');
    expect(selected[1].content).toBe('사용자는 수동 명령보다 자동 기억 형성을 원한다.');
    expect(selected[1].memoryKind).toBe('preference');
    expect(selected.every((memory) => memory.keywords.includes('room:ejclaw'))).toBe(true);
  });

  it('returns no memories for purely operational summaries', () => {
    const selected = selectCompactMemoriesFromSummary(
      '메멘토 대체 v1 로컬 구현은 끝냈습니다. 테스트 599개 통과.',
      'room:ejclaw',
    );

    expect(selected).toEqual([]);
  });

  it('keeps stable rule sentences even when they contain operational words', () => {
    const selected = selectCompactMemoriesFromSummary(
      '배포 전에 항상 테스트를 돌리는 것이 원칙이다.',
      'room:ejclaw',
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].content).toBe('배포 전에 항상 테스트를 돌리는 것이 원칙이다.');
    expect(selected[0].memoryKind).toBe('room_norm');
  });
});
