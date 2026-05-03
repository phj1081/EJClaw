import type { Message } from 'discord.js';

import { STATUS_CHANNEL_ID } from '../config.js';
import { DASHBOARD_STATUS_MESSAGE_MARKER } from '../dashboard-message-cleanup.js';
import { logger } from '../logger.js';
import { readDashboardStatusMessageId } from '../status-dashboard.js';

export const DASHBOARD_TRACKED_SEND_GRACE_MS = 5000;

export function isDashboardTrackedSend(jid: string, text: string): boolean {
  return (
    Boolean(STATUS_CHANNEL_ID) &&
    jid.replace(/^dc:/, '') === STATUS_CHANNEL_ID &&
    text.includes(DASHBOARD_STATUS_MESSAGE_MARKER)
  );
}

export async function deleteOwnDashboardDuplicateOnCreate(args: {
  message: Message;
  channelName: string;
  graceUntil: number;
  now?: number;
}): Promise<void> {
  const { message } = args;
  if (!STATUS_CHANNEL_ID || message.channelId !== STATUS_CHANNEL_ID) return;
  if (!message.content.includes(DASHBOARD_STATUS_MESSAGE_MARKER)) return;

  const keepMessageId = readDashboardStatusMessageId(STATUS_CHANNEL_ID);
  if (!keepMessageId || message.id === keepMessageId) return;
  if ((args.now ?? Date.now()) < args.graceUntil) return;

  try {
    await message.delete();
    logger.info(
      {
        jid: `dc:${message.channelId}`,
        messageId: message.id,
        keepMessageId,
        channelName: args.channelName,
      },
      'Deleted duplicate dashboard message on Discord create event',
    );
  } catch (err) {
    logger.debug(
      {
        jid: `dc:${message.channelId}`,
        messageId: message.id,
        keepMessageId,
        channelName: args.channelName,
        err,
      },
      'Failed to delete duplicate dashboard message on Discord create event',
    );
  }
}
