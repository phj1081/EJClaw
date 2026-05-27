import { updatePairedTurnProgressText } from './db.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import { enqueueMessageRuntimePendingHandoffs } from './message-runtime-handoffs.js';
import {
  buildScopedMessageCheckEnqueuer,
  processMessageLoopTick,
  recoverPendingMessages as recoverRuntimePendingMessages,
} from './message-runtime-loop.js';
import { createImplicitContinuationTracker } from './message-runtime-rules.js';
import { schedulePairedFollowUpWithMessageCheck } from './message-runtime-follow-up.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  createRunAgent,
  createExecuteTurn,
  isDuplicateOfLastBotFinal,
  labelPairedSenders,
} from './message-runtime-turns.js';
import { handleMessageRuntimeAfterDeliverySuccess } from './message-runtime-after-delivery.js';
import { deliverMessageRuntimeFinalText } from './message-runtime-final-delivery.js';
import { createProcessGroupMessages } from './message-runtime-group-processing.js';

export { isDuplicateOfLastBotFinal };

export interface MessageRuntimeDeps {
  assistantName: string;
  idleTimeout: number;
  pollInterval: number;
  timezone: string;
  triggerPattern: RegExp;
  channels: Channel[];
  queue: GroupQueue;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  getLastAgentTimestamps: () => Record<string, string>;
  saveState: () => void;
  persistSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string, opts?: { allRoles?: boolean }) => void;
}

function createStartMessageLoop(args: {
  pollInterval: number;
  processTick: () => Promise<void>;
}): () => Promise<void> {
  let messageLoopRunning = false;

  return async (): Promise<void> => {
    if (messageLoopRunning) {
      logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    messageLoopRunning = true;

    logger.info('EJClaw running');

    while (true) {
      try {
        await args.processTick();
      } catch (err) {
        logger.error({ err }, 'Error in message loop');
      }
      await new Promise((resolve) => setTimeout(resolve, args.pollInterval));
    }
  };
}

export function createMessageRuntime(deps: MessageRuntimeDeps): {
  processGroupMessages: (
    chatJid: string,
    context: GroupRunContext,
  ) => Promise<boolean>;
  recoverPendingMessages: () => void;
  startMessageLoop: () => Promise<void>;
} {
  const FAILURE_FINAL_TEXT = '요청을 완료하지 못했습니다. 다시 시도해 주세요.';
  const continuationTracker = createImplicitContinuationTracker(
    deps.idleTimeout,
  );
  const labelPairedRuntimeSenders = (
    chatJid: string,
    messages: NewMessage[],
  ): NewMessage[] => labelPairedSenders(deps.channels, chatJid, messages);
  const enqueueScopedGroupMessageCheck = buildScopedMessageCheckEnqueuer(
    deps.queue,
  );

  const checkDuplicateOfLastBotFinal = (
    chatJid: string,
    text: string,
  ): boolean => {
    return isDuplicateOfLastBotFinal(chatJid, text);
  };
  const runAgent = createRunAgent({
    assistantName: deps.assistantName,
    queue: deps.queue,
    getRoomBindings: deps.getRoomBindings,
    getSessions: deps.getSessions,
    persistSession: deps.persistSession,
    clearSession: deps.clearSession,
  });
  const executeTurn = createExecuteTurn({
    runAgent,
    assistantName: deps.assistantName,
    idleTimeout: deps.idleTimeout,
    failureFinalText: FAILURE_FINAL_TEXT,
    channels: deps.channels,
    queue: deps.queue,
    getRoomBindings: deps.getRoomBindings,
    getSessions: deps.getSessions,
    persistSession: deps.persistSession,
    clearSession: deps.clearSession,
    deliverFinalText: async ({
      text,
      attachments,
      chatJid,
      runId,
      channel,
      group,
      startSeq,
      endSeq,
      forcedAgentType,
      deliveryRole,
      deliveryServiceId,
      replaceMessageId,
    }) => {
      return deliverMessageRuntimeFinalText({
        text,
        attachments,
        chatJid,
        runId,
        channel,
        group,
        startSeq,
        endSeq,
        forcedAgentType,
        deliveryRole,
        deliveryServiceId,
        replaceMessageId,
        hasDirectTerminalDeliveryForRun:
          deps.queue.hasDirectTerminalDeliveryForRun?.bind(deps.queue),
        isDuplicateOfLastBotFinal: checkDuplicateOfLastBotFinal,
        openContinuation: (targetChatJid) =>
          continuationTracker.open(targetChatJid),
      });
    },
    recordTurnProgress: (turnId, progressText) => {
      updatePairedTurnProgressText(turnId, progressText);
    },
    afterDeliverySuccess: async ({
      chatJid,
      runId,
      deliveryRole,
      pairedRoom,
    }) => {
      await handleMessageRuntimeAfterDeliverySuccess({
        chatJid,
        runId,
        deliveryRole,
        pairedRoom,
        enqueueMessageCheck: (targetChatJid) =>
          deps.queue.enqueueMessageCheck(targetChatJid),
      });
    },
  });

  const enqueuePendingHandoffs = (): void => {
    enqueueMessageRuntimePendingHandoffs({
      enqueueTask: deps.queue.enqueueTask?.bind(deps.queue),
      getRoomBindings: deps.getRoomBindings,
      channels: deps.channels,
      executeTurn,
      getLastAgentTimestamps: deps.getLastAgentTimestamps,
      saveState: deps.saveState,
      enqueueMessageCheck: (chatJid) => deps.queue.enqueueMessageCheck(chatJid),
    });
  };

  const processGroupMessages = createProcessGroupMessages({
    assistantName: deps.assistantName,
    failureFinalText: FAILURE_FINAL_TEXT,
    timezone: deps.timezone,
    triggerPattern: deps.triggerPattern,
    channels: deps.channels,
    queue: deps.queue,
    getRoomBindings: deps.getRoomBindings,
    getLastAgentTimestamps: deps.getLastAgentTimestamps,
    saveState: deps.saveState,
    clearSession: deps.clearSession,
    runAgent,
    executeTurn,
    hasImplicitContinuationWindow: continuationTracker.has,
    openContinuation: continuationTracker.open,
    isDuplicateOfLastBotFinal: checkDuplicateOfLastBotFinal,
    labelPairedSenders: labelPairedRuntimeSenders,
  });

  const startMessageLoop = createStartMessageLoop({
    pollInterval: deps.pollInterval,
    processTick: async () => {
      await processMessageLoopTick({
        assistantName: deps.assistantName,
        failureFinalText: FAILURE_FINAL_TEXT,
        triggerPattern: deps.triggerPattern,
        timezone: deps.timezone,
        channels: deps.channels,
        getRoomBindings: deps.getRoomBindings,
        getLastTimestamp: deps.getLastTimestamp,
        setLastTimestamp: deps.setLastTimestamp,
        lastAgentTimestamps: deps.getLastAgentTimestamps(),
        saveState: deps.saveState,
        hasImplicitContinuationWindow: continuationTracker.has,
        executeTurn,
        enqueuePendingHandoffs,
        schedulePairedFollowUpWithMessageCheck,
        enqueueScopedGroupMessageCheck,
        sendQueuedMessage: deps.queue.sendMessage.bind(deps.queue),
        closeStdin: (chatJid, reason) =>
          deps.queue.closeStdin(chatJid, {
            reason,
          }),
        isRunningMessageTurn: (chatJid) =>
          deps.queue.getStatuses([chatJid])[0]?.runPhase === 'running_messages',
        labelPairedSenders: labelPairedRuntimeSenders,
      });
    },
  });

  const recoverPendingMessages = (): void => {
    recoverRuntimePendingMessages({
      assistantName: deps.assistantName,
      channels: deps.channels,
      getRoomBindings: deps.getRoomBindings,
      lastAgentTimestamps: deps.getLastAgentTimestamps(),
      saveState: deps.saveState,
      enqueueScopedGroupMessageCheck,
    });
  };

  return {
    processGroupMessages,
    recoverPendingMessages,
    startMessageLoop,
  };
}
