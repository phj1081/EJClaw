import { logger } from './logger.js';
import type { Channel } from './types.js';

export const DASHBOARD_STATUS_MESSAGE_MARKER = '🤖 *모델 구성*';
const DASHBOARD_DUPLICATE_CLEANUP_LIMIT = 100;

function findDashboardCleanupChannel(opts: {
  channels: Channel[];
  statusChannelId: string;
}): Channel | undefined {
  if (!opts.statusChannelId) return undefined;
  return opts.channels.find(
    (item) =>
      item.name.startsWith('discord') &&
      item.isConnected() &&
      item.deleteRecentMessagesByContent,
  );
}

export async function purgeDashboardMessages(opts: {
  channels: Channel[];
  statusChannelId: string;
}): Promise<number> {
  const channel = findDashboardCleanupChannel(opts);
  if (!channel?.deleteRecentMessagesByContent) return 0;

  let total = 0;
  for (let i = 0; i < 10; i += 1) {
    const deleted = await channel.deleteRecentMessagesByContent(
      `dc:${opts.statusChannelId}`,
      {
        contentIncludes: DASHBOARD_STATUS_MESSAGE_MARKER,
        limit: DASHBOARD_DUPLICATE_CLEANUP_LIMIT,
      },
    );
    total += deleted;
    if (deleted < DASHBOARD_DUPLICATE_CLEANUP_LIMIT) break;
  }
  return total;
}

export async function cleanupDashboardDuplicateMessages(
  opts: { channels: Channel[]; statusChannelId: string },
  keepMessageId: string | null,
): Promise<number> {
  if (!opts.statusChannelId || !keepMessageId) return 0;

  const channel = findDashboardCleanupChannel(opts);
  if (!channel?.deleteRecentMessagesByContent) return 0;

  try {
    return await channel.deleteRecentMessagesByContent(
      `dc:${opts.statusChannelId}`,
      {
        contentIncludes: DASHBOARD_STATUS_MESSAGE_MARKER,
        exceptMessageId: keepMessageId,
        limit: DASHBOARD_DUPLICATE_CLEANUP_LIMIT,
      },
    );
  } catch (err) {
    logger.warn(
      { err, keepMessageId },
      'Dashboard duplicate message cleanup failed',
    );
    return 0;
  }
}
