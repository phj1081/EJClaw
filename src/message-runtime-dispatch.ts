import { logger } from './logger.js';
import { getLatestOpenPairedTaskForChat, getMessagesSinceSeq } from './db.js';
import {
  buildQueuedTurnDispatch,
  executeBotOnlyPairedFollowUpAction,
} from './message-runtime-flow.js';
import {
  advanceLastAgentCursor,
  filterLoopingPairedBotMessages,
  getProcessableMessages,
  resolveCursorKey,
  shouldSkipBotOnlyCollaboration,
} from './message-runtime-rules.js';
import { enqueuePairedFollowUpAfterEvent } from './message-runtime-follow-up.js';
import {
  extractSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { isSessionCommandSenderAllowed } from './config.js';
import { hasReviewerLease } from './service-routing.js';
import type { ExecuteTurnFn } from './message-runtime-types.js';
import type { ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import type {
  Channel,
  NewMessage,
  PairedTask,
  PairedRoomRole,
  RegisteredGroup,
} from './types.js';

type RuntimeLog = Pick<typeof logger, 'info' | 'debug'>;

function hasExternalHumanMessage(messages: NewMessage[]): boolean {
  return messages.some(
    (message) => message.is_from_me !== true && !message.is_bot_message,
  );
}

export function enqueueGenericFollowUpAfterDeliveryRetry(args: {
  chatJid: string;
  runId: string;
  deliveryRole: PairedRoomRole;
  pendingTask: PairedTask | null | undefined;
  workItemId: string | number;
  log: RuntimeLog;
  enqueueMessageCheck: () => void;
}): void {
  const followUpResult = enqueuePairedFollowUpAfterEvent({
    chatJid: args.chatJid,
    runId: args.runId,
    task: args.pendingTask,
    source: 'delivery-retry',
    completedRole: args.deliveryRole,
    fallbackLastTurnOutputRole: args.deliveryRole,
    enqueueMessageCheck: args.enqueueMessageCheck,
  });

  if (followUpResult.kind === 'none') {
    args.log.info(
      {
        workItemId: args.workItemId,
        chatJid: args.chatJid,
        deliveryRole: args.deliveryRole,
        pendingTaskStatus: followUpResult.taskStatus,
      },
      'No queued follow-up was required after delivery retry',
    );
    return;
  }

  if (followUpResult.kind === 'message-check') {
    return;
  }

  if (followUpResult.scheduled) {
    args.log.info(
      {
        workItemId: args.workItemId,
        chatJid: args.chatJid,
        deliveryRole: args.deliveryRole,
        taskId: followUpResult.taskId,
        pendingTaskStatus: followUpResult.taskStatus,
        taskStatus: followUpResult.taskStatus,
        intentKind: followUpResult.intentKind,
      },
      'Queued paired follow-up after delivery retry',
    );
    return;
  }
  if (!followUpResult.scheduled) {
    args.log.info(
      {
        workItemId: args.workItemId,
        chatJid: args.chatJid,
        deliveryRole: args.deliveryRole,
        taskId: followUpResult.taskId,
        pendingTaskStatus: followUpResult.taskStatus,
        taskStatus: followUpResult.taskStatus,
        intentKind: followUpResult.intentKind,
      },
      'Skipped duplicate paired follow-up enqueue after delivery retry while task state was unchanged',
    );
  }
}

export async function processQueuedGroupDispatch(args: {
  chatJid: string;
  group: RegisteredGroup;
  channel: Channel;
  processableGroupMessages: NewMessage[];
  assistantName: string;
  failureFinalText: string;
  timezone: string;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  executeTurn: ExecuteTurnFn;
  schedulePairedFollowUp: (
    task: PairedTask | null | undefined,
    intentKind: ScheduledPairedFollowUpIntentKind,
    runId: string,
  ) => boolean;
  enqueueMessageCheck: () => void;
  sendQueuedMessage: (chatJid: string, text: string) => boolean;
  closeStdin: (reason: string) => void;
  labelPairedSenders: (chatJid: string, messages: NewMessage[]) => NewMessage[];
  formatMessages: (messages: NewMessage[], timezone: string) => string;
}): Promise<void> {
  const { chatJid, group, channel, processableGroupMessages } = args;
  const loopPendingTask = hasReviewerLease(chatJid)
    ? getLatestOpenPairedTaskForChat(chatJid)
    : null;
  const loopCursorKey = resolveCursorKey(chatJid, loopPendingTask?.status);
  const rawPendingMessages = getMessagesSinceSeq(
    chatJid,
    args.lastAgentTimestamps[loopCursorKey] || '0',
    args.assistantName,
  );
  const pendingMessages = filterLoopingPairedBotMessages(
    chatJid,
    getProcessableMessages(chatJid, rawPendingMessages, channel),
    args.failureFinalText,
  );
  const messagesToSend =
    pendingMessages.length > 0 ? pendingMessages : processableGroupMessages;
  const labeledMessagesToSend = args.labelPairedSenders(
    chatJid,
    messagesToSend,
  );
  const {
    formatted,
    botOnlyFollowUpAction,
    isBotOnlyPairedFollowUp,
    loopCursorKey: dispatchCursorKey,
    endSeq,
  } = buildQueuedTurnDispatch({
    chatJid,
    timezone: args.timezone,
    loopPendingTask,
    rawPendingMessages,
    messagesToSend,
    labeledMessagesToSend,
    formatMessages: args.formatMessages,
  });

  const botOnlyFollowUpRunId = `loop-merge-ready-${Date.now().toString(36)}`;
  if (
    await executeBotOnlyPairedFollowUpAction({
      action: botOnlyFollowUpAction,
      chatJid,
      group,
      runId: botOnlyFollowUpRunId,
      channel,
      log: logger,
      saveState: args.saveState,
      lastAgentTimestamps: args.lastAgentTimestamps,
      executeTurn: args.executeTurn,
      schedulePairedFollowUp: (task, intentKind) =>
        args.schedulePairedFollowUp(task, intentKind, botOnlyFollowUpRunId),
      closeStdin: () => args.closeStdin('paired-pending-turn-follow-up'),
    })
  ) {
    return;
  }

  if (args.sendQueuedMessage(chatJid, formatted)) {
    if (endSeq != null) {
      advanceLastAgentCursor(
        args.lastAgentTimestamps,
        args.saveState,
        chatJid,
        endSeq,
        dispatchCursorKey,
      );
    }
    logger.debug(
      {
        transition: 'typing:on',
        source: 'follow-up-queued',
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        endSeq: endSeq ?? null,
        suppressed: isBotOnlyPairedFollowUp,
      },
      'Typing indicator transition',
    );
    if (!isBotOnlyPairedFollowUp) {
      await channel
        .setTyping?.(chatJid, true)
        ?.catch((err) =>
          logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
        );
    }
    return;
  }

  args.enqueueMessageCheck();
}

export async function processLoopGroupMessages(args: {
  chatJid: string;
  group: RegisteredGroup;
  groupMessages: NewMessage[];
  channel: Channel;
  assistantName: string;
  failureFinalText: string;
  triggerPattern: RegExp;
  hasImplicitContinuationWindow: (
    chatJid: string,
    messages: NewMessage[],
  ) => boolean;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  timezone: string;
  executeTurn: ExecuteTurnFn;
  schedulePairedFollowUp: (
    task: PairedTask | null | undefined,
    intentKind: ScheduledPairedFollowUpIntentKind,
    runId: string,
  ) => boolean;
  enqueueMessageCheck: () => void;
  sendQueuedMessage: (chatJid: string, text: string) => boolean;
  closeStdin: (reason: string) => void;
  isRunningMessageTurn: (chatJid: string) => boolean;
  labelPairedSenders: (chatJid: string, messages: NewMessage[]) => NewMessage[];
  formatMessages: (messages: NewMessage[], timezone: string) => string;
}): Promise<void> {
  const { chatJid, group, groupMessages, channel } = args;
  const isMainGroup = group.isMain === true;
  const processableGroupMessages = getProcessableMessages(
    chatJid,
    groupMessages,
    channel,
  );

  if (processableGroupMessages.length === 0) {
    const lastIgnored = groupMessages[groupMessages.length - 1];
    if (lastIgnored?.seq != null) {
      advanceLastAgentCursor(
        args.lastAgentTimestamps,
        args.saveState,
        chatJid,
        lastIgnored.seq,
      );
    }
    return;
  }

  if (shouldSkipBotOnlyCollaboration(chatJid, processableGroupMessages)) {
    const lastIgnored =
      processableGroupMessages[processableGroupMessages.length - 1];
    if (lastIgnored?.seq != null) {
      advanceLastAgentCursor(
        args.lastAgentTimestamps,
        args.saveState,
        chatJid,
        lastIgnored.seq,
      );
    }
    logger.info(
      { chatJid, group: group.name, groupFolder: group.folder },
      'Bot-collaboration timeout: no recent human message, skipping',
    );
    return;
  }

  const loopCmdMsg = groupMessages.find(
    (msg) => extractSessionCommand(msg.content, args.triggerPattern) !== null,
  );

  if (loopCmdMsg) {
    if (
      isSessionCommandAllowed(
        isMainGroup,
        loopCmdMsg.is_from_me === true,
        isSessionCommandSenderAllowed(loopCmdMsg.sender),
      )
    ) {
      args.closeStdin('session-command-detected');
    }
    args.enqueueMessageCheck();
    return;
  }

  if (hasExternalHumanMessage(processableGroupMessages)) {
    const interruptedActiveRun = args.isRunningMessageTurn(chatJid);
    if (interruptedActiveRun) {
      args.closeStdin('human-message-detected');
    }
    args.enqueueMessageCheck();
    logger.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        messageCount: processableGroupMessages.length,
        interruptedActiveRun,
      },
      'Queued human message for a fresh turn instead of piping into active agent',
    );
    return;
  }

  await processQueuedGroupDispatch({
    chatJid,
    group,
    channel,
    processableGroupMessages,
    assistantName: args.assistantName,
    failureFinalText: args.failureFinalText,
    timezone: args.timezone,
    lastAgentTimestamps: args.lastAgentTimestamps,
    saveState: args.saveState,
    executeTurn: args.executeTurn,
    schedulePairedFollowUp: args.schedulePairedFollowUp,
    enqueueMessageCheck: args.enqueueMessageCheck,
    sendQueuedMessage: args.sendQueuedMessage,
    closeStdin: args.closeStdin,
    labelPairedSenders: args.labelPairedSenders,
    formatMessages: args.formatMessages,
  });
}
