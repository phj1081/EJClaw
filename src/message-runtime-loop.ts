import {
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  getOpenWorkItemForChat,
} from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { processLoopGroupMessages } from './message-runtime-dispatch.js';
import {
  advanceLastAgentCursor,
  getProcessableMessages,
} from './message-runtime-rules.js';
import { SERVICE_SESSION_SCOPE } from './config.js';
import type { schedulePairedFollowUpWithMessageCheck } from './message-runtime-follow-up.js';
import type { ExecuteTurnFn } from './message-runtime-types.js';
import { findChannel, formatMessages } from './router.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

export async function processMessageLoopTick(args: {
  assistantName: string;
  failureFinalText: string;
  triggerPattern: RegExp;
  timezone: string;
  channels: Channel[];
  getRoomBindings: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  hasImplicitContinuationWindow: (
    chatJid: string,
    messages: NewMessage[],
  ) => boolean;
  executeTurn: ExecuteTurnFn;
  enqueuePendingHandoffs: () => void;
  schedulePairedFollowUpWithMessageCheck: typeof schedulePairedFollowUpWithMessageCheck;
  enqueueScopedGroupMessageCheck: (
    chatJid: string,
    groupFolder: string,
  ) => void;
  sendQueuedMessage: (chatJid: string, text: string) => boolean;
  closeStdin: (chatJid: string, reason: string) => void;
  isRunningMessageTurn: (chatJid: string) => boolean;
  labelPairedSenders: (chatJid: string, messages: NewMessage[]) => NewMessage[];
}): Promise<void> {
  args.enqueuePendingHandoffs();
  const roomBindings = args.getRoomBindings();
  const jids = Object.keys(roomBindings);
  const { messages, newSeqCursor } = getNewMessagesBySeq(
    jids,
    args.getLastTimestamp(),
    args.assistantName,
  );

  if (messages.length === 0) {
    return;
  }

  logger.info({ count: messages.length }, 'New messages');
  args.setLastTimestamp(newSeqCursor);
  args.saveState();

  const messagesByGroup = new Map<string, NewMessage[]>();
  for (const msg of messages) {
    const existing = messagesByGroup.get(msg.chat_jid);
    if (existing) {
      existing.push(msg);
    } else {
      messagesByGroup.set(msg.chat_jid, [msg]);
    }
  }

  for (const [chatJid, groupMessages] of messagesByGroup) {
    const group = roomBindings[chatJid];
    if (!group) continue;

    const channel = findChannel(args.channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      continue;
    }

    await processLoopGroupMessages({
      chatJid,
      group,
      groupMessages,
      channel,
      assistantName: args.assistantName,
      failureFinalText: args.failureFinalText,
      triggerPattern: args.triggerPattern,
      hasImplicitContinuationWindow: args.hasImplicitContinuationWindow,
      lastAgentTimestamps: args.lastAgentTimestamps,
      saveState: args.saveState,
      timezone: args.timezone,
      executeTurn: args.executeTurn,
      schedulePairedFollowUp: (task, intentKind, followUpRunId) =>
        args.schedulePairedFollowUpWithMessageCheck({
          chatJid,
          runId: followUpRunId,
          task,
          intentKind,
          enqueueMessageCheck: () =>
            args.enqueueScopedGroupMessageCheck(chatJid, group.folder),
        }),
      enqueueMessageCheck: () =>
        args.enqueueScopedGroupMessageCheck(chatJid, group.folder),
      sendQueuedMessage: args.sendQueuedMessage,
      closeStdin: (reason) => args.closeStdin(chatJid, reason),
      isRunningMessageTurn: args.isRunningMessageTurn,
      labelPairedSenders: args.labelPairedSenders,
      formatMessages,
    });
  }
}

export function recoverPendingMessages(args: {
  assistantName: string;
  channels: Channel[];
  getRoomBindings: () => Record<string, RegisteredGroup>;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  enqueueScopedGroupMessageCheck: (
    chatJid: string,
    groupFolder: string,
  ) => void;
}): void {
  const roomBindings = args.getRoomBindings();
  for (const [chatJid, group] of Object.entries(roomBindings)) {
    const openWorkItem = getOpenWorkItemForChat(chatJid, SERVICE_SESSION_SCOPE);
    if (openWorkItem) {
      logger.info(
        { chatJid, group: group.name, workItemId: openWorkItem.id },
        'Recovery: found open work item awaiting delivery',
      );
      args.enqueueScopedGroupMessageCheck(chatJid, group.folder);
      continue;
    }

    const sinceSeqCursor = args.lastAgentTimestamps[chatJid] || '';
    const rawPending = getMessagesSinceSeq(
      chatJid,
      sinceSeqCursor,
      args.assistantName,
    );
    const recoveryChannel = findChannel(args.channels, chatJid);
    const pending = getProcessableMessages(
      chatJid,
      rawPending,
      recoveryChannel ?? undefined,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      args.enqueueScopedGroupMessageCheck(chatJid, group.folder);
      continue;
    }

    if (rawPending.length > 0) {
      const endSeq = rawPending[rawPending.length - 1].seq;
      if (endSeq != null) {
        advanceLastAgentCursor(
          args.lastAgentTimestamps,
          args.saveState,
          chatJid,
          endSeq,
        );
      }
    }
  }
}

export function buildScopedMessageCheckEnqueuer(queue: {
  enqueueMessageCheck: (chatJid: string, ipcDir?: string) => void;
}): (chatJid: string, groupFolder: string) => void {
  return (chatJid: string, groupFolder: string): void => {
    queue.enqueueMessageCheck(chatJid, resolveGroupIpcPath(groupFolder));
  };
}
