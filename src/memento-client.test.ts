import { describe, expect, it } from 'vitest';

import {
  buildRoomMemoryKey,
  formatRoomMemoryBriefing,
} from './memento-client.js';

describe('memento-client helpers', () => {
  it('builds a stable room memory key from the group folder', () => {
    expect(buildRoomMemoryKey('ejclaw')).toBe('room:ejclaw');
  });

  it('formats recalled fragments into a compact session briefing', () => {
    const briefing = formatRoomMemoryBriefing('room:ejclaw', [
      {
        id: 'frag-1',
        content: '사용자는 세션 리셋 후에도 방 맥락이 이어지길 원함.',
        type: 'decision',
        topic: 'room-memory',
      },
      {
        id: 'frag-2',
        content: '자동 recall/reflect를 호스트가 책임지는 방향으로 합의함.',
        type: 'fact',
      },
    ]);

    expect(briefing).toContain('## Shared Room Memory');
    expect(briefing).toContain('room:ejclaw');
    expect(briefing).toContain(
      '[decision / room-memory] 사용자는 세션 리셋 후에도 방 맥락이 이어지길 원함.',
    );
    expect(briefing).toContain(
      '[fact] 자동 recall/reflect를 호스트가 책임지는 방향으로 합의함.',
    );
  });

  it('trims overly long briefings to the configured max length', () => {
    const briefing = formatRoomMemoryBriefing(
      'room:ejclaw',
      [
        {
          id: 'frag-1',
          content: 'a'.repeat(300),
          type: 'fact',
        },
      ],
      120,
    );

    expect(briefing).toBeDefined();
    expect(briefing!.length).toBeLessThanOrEqual(120);
    expect(briefing!.endsWith('…')).toBe(true);
  });
});
