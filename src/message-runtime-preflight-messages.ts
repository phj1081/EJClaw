import { getMessagesSinceSeq } from './db.js';
import {
  filterLoopingPairedBotMessages,
  getProcessableMessages,
} from './message-runtime-rules.js';
import type { WorkItem } from './db/work-items.js';
import type { Channel, NewMessage } from './types.js';

export function getFreshHumanPreflightMessages(args: {
  chatJid: string;
  channel: Channel;
  lastAgentTimestamps: Record<string, string>;
  assistantName: string;
  failureFinalText: string;
}): NewMessage[] {
  const sinceSeqCursor = args.lastAgentTimestamps[args.chatJid] || '0';
  const preflightRawMessages = getMessagesSinceSeq(
    args.chatJid,
    sinceSeqCursor,
    args.assistantName,
  );
  const preflightMessages = filterLoopingPairedBotMessages(
    args.chatJid,
    getProcessableMessages(args.chatJid, preflightRawMessages, args.channel),
    args.failureFinalText,
  );
  return preflightMessages.filter(
    (message) => message.is_from_me !== true && !message.is_bot_message,
  );
}

export function hasHumanMessageAfterWorkItem(
  openWorkItem: WorkItem,
  freshHumanMessages: NewMessage[],
): boolean {
  if (freshHumanMessages.length === 0) {
    return false;
  }

  const workItemSeq = openWorkItem.end_seq ?? openWorkItem.start_seq ?? null;
  const workItemUpdatedAt = Date.parse(openWorkItem.updated_at);

  return freshHumanMessages.some((message) => {
    if (message.seq != null && workItemSeq != null) {
      return message.seq > workItemSeq;
    }

    const messageTimestamp = Date.parse(message.timestamp);
    if (
      Number.isFinite(messageTimestamp) &&
      Number.isFinite(workItemUpdatedAt)
    ) {
      return messageTimestamp > workItemUpdatedAt;
    }

    return true;
  });
}
