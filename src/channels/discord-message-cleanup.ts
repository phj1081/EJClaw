import type { Client, TextChannel } from 'discord.js';

import { logger } from '../logger.js';
import type { DeleteRecentMessagesByContentOptions } from '../types.js';

export async function deleteRecentDiscordMessagesByContent(args: {
  client: Client | null;
  channelName: string;
  jid: string;
  options: DeleteRecentMessagesByContentOptions;
}): Promise<number> {
  if (!args.client) return 0;

  const contentIncludes = args.options.contentIncludes.trim();
  if (!contentIncludes) return 0;

  let deleted = 0;
  try {
    const channelId = args.jid.replace(/^dc:/, '');
    const channel = await args.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) return 0;

    const tc = channel as TextChannel;
    const messages = await tc.messages.fetch({
      limit: Math.max(1, Math.min(args.options.limit ?? 100, 100)),
    });
    const candidates = messages.filter(
      (message) =>
        message.author.id === args.client?.user?.id &&
        message.id !== args.options.exceptMessageId &&
        message.content.includes(contentIncludes),
    );
    if (candidates.size === 0) return 0;

    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = candidates.filter(
      (message) => message.createdTimestamp > twoWeeksAgo,
    );
    const old = candidates.filter(
      (message) => message.createdTimestamp <= twoWeeksAgo,
    );

    if (recent.size >= 2 && 'bulkDelete' in channel) {
      await tc.bulkDelete(recent);
      deleted += recent.size;
    } else {
      for (const [, message] of recent) {
        await message.delete();
        deleted += 1;
      }
    }

    for (const [, message] of old) {
      await message.delete();
      deleted += 1;
    }

    logger.info(
      {
        jid: args.jid,
        deleted,
        exceptMessageId: args.options.exceptMessageId ?? null,
        channelName: args.channelName,
      },
      'Deleted duplicate Discord messages by content marker',
    );
  } catch (err) {
    logger.warn(
      {
        jid: args.jid,
        err,
        deleted,
        exceptMessageId: args.options.exceptMessageId ?? null,
        channelName: args.channelName,
      },
      'Failed to delete duplicate Discord messages by content marker',
    );
  }

  return deleted;
}
