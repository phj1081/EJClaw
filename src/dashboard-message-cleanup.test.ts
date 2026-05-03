import { describe, expect, it, vi } from 'vitest';

import {
  cleanupDashboardDuplicateMessages,
  purgeDashboardMessages,
} from './dashboard-message-cleanup.js';

function makeChannel(deleteRecentMessagesByContent: any) {
  return {
    name: 'discord',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: vi.fn(),
    deleteRecentMessagesByContent,
  };
}

describe('cleanupDashboardDuplicateMessages', () => {
  it('deletes recent dashboard messages except the tracked status message', async () => {
    const deleteRecentMessagesByContent = vi.fn(async () => 3);
    const deleted = await cleanupDashboardDuplicateMessages(
      {
        statusChannelId: 'status-channel',
        channels: [makeChannel(deleteRecentMessagesByContent)],
      },
      'tracked-message',
    );

    expect(deleted).toBe(3);
    expect(deleteRecentMessagesByContent).toHaveBeenCalledWith(
      'dc:status-channel',
      {
        contentIncludes: '🤖 *모델 구성*',
        exceptMessageId: 'tracked-message',
        limit: 100,
      },
    );
  });

  it('skips cleanup when there is no tracked status message yet', async () => {
    const deleteRecentMessagesByContent = vi.fn(async () => 3);
    const deleted = await cleanupDashboardDuplicateMessages(
      {
        statusChannelId: 'status-channel',
        channels: [makeChannel(deleteRecentMessagesByContent)],
      },
      null,
    );

    expect(deleted).toBe(0);
    expect(deleteRecentMessagesByContent).not.toHaveBeenCalled();
  });
});

describe('purgeDashboardMessages', () => {
  it('deletes dashboard marker messages without purging the whole channel', async () => {
    const deleteRecentMessagesByContent = vi.fn(async () => 2);
    const deleted = await purgeDashboardMessages({
      statusChannelId: 'status-channel',
      channels: [makeChannel(deleteRecentMessagesByContent)],
    });

    expect(deleted).toBe(2);
    expect(deleteRecentMessagesByContent).toHaveBeenCalledWith(
      'dc:status-channel',
      {
        contentIncludes: '🤖 *모델 구성*',
        limit: 100,
      },
    );
  });

  it('continues deleting dashboard batches until the last batch is partial', async () => {
    const deleteRecentMessagesByContent = vi
      .fn()
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(7);
    const deleted = await purgeDashboardMessages({
      statusChannelId: 'status-channel',
      channels: [makeChannel(deleteRecentMessagesByContent)],
    });

    expect(deleted).toBe(107);
    expect(deleteRecentMessagesByContent).toHaveBeenCalledTimes(2);
  });
});
