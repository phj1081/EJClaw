import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _setMemoryTimestampsForTests,
  recallMemories,
  rememberMemory,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('memories', () => {
  it('recalls scoped memories through FTS and exact keyword matching', () => {
    rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      content: '세션 재시작 후에도 방 메모리를 주입한다.',
      keywords: ['room:test-group', 'session-reset'],
      sourceKind: 'compact',
      sourceRef: 'compact:1',
    });
    rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      content: '이 메모리는 다른 검색어다.',
      keywords: ['room:test-group'],
      sourceKind: 'compact',
      sourceRef: 'compact:2',
    });

    const byText = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      text: 'session reset',
      limit: 5,
    });
    expect(byText).toHaveLength(1);
    expect(byText[0].content).toContain('방 메모리를 주입한다');

    const byKeyword = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:test-group',
      keywords: ['session-reset'],
      limit: 5,
    });
    expect(byKeyword).toHaveLength(1);
    expect(byKeyword[0].content).toContain('방 메모리를 주입한다');
  });

  it('archives old memories when a scope exceeds its bounded limit', () => {
    for (let index = 0; index < 305; index += 1) {
      rememberMemory({
        scopeKind: 'room',
        scopeKey: 'room:bounded',
        content: `memory-${index}`,
        keywords: ['room:bounded'],
        sourceKind: 'compact',
        sourceRef: `compact:${index}`,
      });
    }

    const recalled = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:bounded',
      limit: 500,
    });

    expect(recalled).toHaveLength(300);
    expect(recalled.some((memory) => memory.content === 'memory-0')).toBe(
      false,
    );
    expect(recalled.some((memory) => memory.content === 'memory-304')).toBe(
      true,
    );
  });

  it('archives stale compact memories before recall using last_used_at TTL', () => {
    const staleId = rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:ttl',
      content: '오래된 compact memory',
      keywords: ['room:ttl'],
      sourceKind: 'compact',
      sourceRef: 'compact:stale',
    });
    rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:ttl',
      content: '최근에 다시 쓰인 compact memory',
      keywords: ['room:ttl'],
      sourceKind: 'compact',
      sourceRef: 'compact:fresh',
    });

    _setMemoryTimestampsForTests(staleId, {
      createdAt: '2020-01-01T00:00:00.000Z',
      lastUsedAt: '2020-01-02T00:00:00.000Z',
    });

    const recalled = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:ttl',
      limit: 10,
    });

    expect(
      recalled.some((memory) => memory.content === '오래된 compact memory'),
    ).toBe(false);
    expect(
      recalled.some(
        (memory) => memory.content === '최근에 다시 쓰인 compact memory',
      ),
    ).toBe(true);
  });

  it('keeps explicit memories even when they are old', () => {
    const explicitId = rememberMemory({
      scopeKind: 'room',
      scopeKey: 'room:ttl-explicit',
      content: '관리자가 남긴 고정 규칙',
      keywords: ['room:ttl-explicit'],
      sourceKind: 'explicit',
      sourceRef: 'msg:1',
    });

    _setMemoryTimestampsForTests(explicitId, {
      createdAt: '2020-01-01T00:00:00.000Z',
      lastUsedAt: '2020-01-02T00:00:00.000Z',
    });

    const recalled = recallMemories({
      scopeKind: 'room',
      scopeKey: 'room:ttl-explicit',
      limit: 10,
    });

    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toBe('관리자가 남긴 고정 규칙');
  });
});
