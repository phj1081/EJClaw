import { describe, expect, it, vi } from 'vitest';

import { deleteRecentDiscordMessagesByContent } from './discord-message-cleanup.js';

class MockMessageCollection extends Map<string, any> {
  filter(predicate: (message: any, id: string) => boolean) {
    const filtered = new MockMessageCollection();
    for (const [id, message] of this.entries()) {
      if (predicate(message, id)) filtered.set(id, message);
    }
    return filtered;
  }
}

describe('deleteRecentDiscordMessagesByContent', () => {
  it('deletes duplicate own dashboard messages while keeping the tracked one', async () => {
    const keepDelete = vi.fn();
    const duplicateDelete = vi.fn();
    const otherBotDelete = vi.fn();
    const normalDelete = vi.fn();
    const messages = new MockMessageCollection([
      [
        'tracked',
        {
          id: 'tracked',
          author: { id: '999888777' },
          content: '🤖 *모델 구성*\ntracked',
          createdTimestamp: Date.now(),
          delete: keepDelete,
        },
      ],
      [
        'duplicate',
        {
          id: 'duplicate',
          author: { id: '999888777' },
          content: '🤖 *모델 구성*\nduplicate',
          createdTimestamp: Date.now(),
          delete: duplicateDelete,
        },
      ],
      [
        'other-bot',
        {
          id: 'other-bot',
          author: { id: 'other-bot' },
          content: '🤖 *모델 구성*\nother bot',
          createdTimestamp: Date.now(),
          delete: otherBotDelete,
        },
      ],
      [
        'normal',
        {
          id: 'normal',
          author: { id: '999888777' },
          content: 'normal tracked message',
          createdTimestamp: Date.now(),
          delete: normalDelete,
        },
      ],
    ]);
    const client = {
      user: { id: '999888777' },
      channels: {
        fetch: vi.fn().mockResolvedValue({
          messages: {
            fetch: vi.fn().mockResolvedValue(messages),
          },
        }),
      },
    };

    const deleted = await deleteRecentDiscordMessagesByContent({
      client: client as any,
      channelName: 'discord',
      jid: 'dc:1234567890123456',
      options: {
        contentIncludes: '🤖 *모델 구성*',
        exceptMessageId: 'tracked',
      },
    });

    expect(deleted).toBe(1);
    expect(duplicateDelete).toHaveBeenCalledTimes(1);
    expect(keepDelete).not.toHaveBeenCalled();
    expect(otherBotDelete).not.toHaveBeenCalled();
    expect(normalDelete).not.toHaveBeenCalled();
  });
});
