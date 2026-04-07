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
import type { ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import { findChannel, formatMessages } from './router.js';
import type {
  AgentType,
  Channel,
  NewMessage,
  PairedRoomRole,
  PairedTask,
  RegisteredGroup,
} from './types.js';

type ExecuteTurnFn = (args: {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  runId: string;
  channel: Channel;
  startSeq: number | null;
  endSeq: number | null;
  deliveryRole?: PairedRoomRole;
  hasHumanMessage?: boolean;
  forcedRole?: PairedRoomRole;
  forcedAgentType?: AgentType;
}) => Promise<{
  outputStatus: 'success' | 'error';
  deliverySucceeded: boolean;
  visiblePhase: unknown;
}>;

export async function processMessageLoopTick(args: {
  assistantName: string;
  failureFinalText: string;
  triggerPattern: RegExp;
  timezone: string;
  channels: Channel[];
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
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
  scheduleQueuedPairedFollowUp: (args: {
    chatJid: string;
    runId: string;
    task: PairedTask | null | undefined;
    intentKind: ScheduledPairedFollowUpIntentKind;
    enqueue: () => void;
  }) => boolean;
  enqueueScopedGroupMessageCheck: (chatJid: string, groupFolder: string) => void;
  sendQueuedMessage: (chatJid: string, text: string) => boolean;
  closeStdin: (chatJid: string, reason: string) => void;
  labelPairedSenders: (chatJid: string, messages: NewMessage[]) => NewMessage[];
}): Promise<void> {
  args.enqueuePendingHandoffs();
  const registeredGroups = args.getRegisteredGroups();
  const jids = Object.keys(registeredGroups);
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
    const group = registeredGroups[chatJid];
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
        args.scheduleQueuedPairedFollowUp({
          chatJid,
          runId: followUpRunId,
          task,
          intentKind,
          enqueue: () =>
            args.enqueueScopedGroupMessageCheck(chatJid, group.folder),
        }),
      enqueueMessageCheck: () =>
        args.enqueueScopedGroupMessageCheck(chatJid, group.folder),
      sendQueuedMessage: args.sendQueuedMessage,
      closeStdin: (reason) => args.closeStdin(chatJid, reason),
      labelPairedSenders: args.labelPairedSenders,
      formatMessages,
    });
  }
}

export function recoverPendingMessages(args: {
  assistantName: string;
  channels: Channel[];
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  enqueueScopedGroupMessageCheck: (chatJid: string, groupFolder: string) => void;
}): void {
  const registeredGroups = args.getRegisteredGroups();
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const openWorkItem = getOpenWorkItemForChat(chatJid);
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
