import {
  getOpenWorkItemForChat,
  getMessagesSinceSeq,
  getLatestOpenPairedTaskForChat,
  markWorkItemDelivered,
  updatePairedTurnProgressText,
} from './db.js';
import {
  isSessionCommandSenderAllowed,
  SERVICE_SESSION_SCOPE,
} from './config.js';
import { resolveRuntimeAttachmentBaseDirs } from './attachment-base-dirs.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import { findChannel, formatMessages } from './router.js';
import { enqueueGenericFollowUpAfterDeliveryRetry as enqueueDeliveryRetryFollowUp } from './message-runtime-dispatch.js';
import { processOpenWorkItemDelivery } from './message-runtime-delivery.js';
import { deliverCanonicalOutboundMessage } from './ipc-outbound-delivery.js';
import { handleQueuedRunGates } from './message-runtime-gating.js';
import { enqueueMessageRuntimePendingHandoffs } from './message-runtime-handoffs.js';
import {
  buildScopedMessageCheckEnqueuer,
  processMessageLoopTick,
  recoverPendingMessages as recoverRuntimePendingMessages,
} from './message-runtime-loop.js';
import {
  runPendingPairedTurnIfNeeded,
  runQueuedGroupTurn,
} from './message-runtime-queue.js';
import {
  advanceLastAgentCursor,
  createImplicitContinuationTracker,
  filterLoopingPairedBotMessages,
  getProcessableMessages,
  shouldSkipBotOnlyCollaboration,
} from './message-runtime-rules.js';
import { resolveOwnerTaskForHumanMessage } from './paired-execution-context.js';
import { schedulePairedFollowUpWithMessageCheck } from './message-runtime-follow-up.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { createScopedLogger, logger } from './logger.js';
import { hasReviewerLease } from './service-routing.js';
import {
  getFixedRoleChannelName,
  getMissingRoleChannelMessage,
} from './message-runtime-shared.js';
import {
  createRunAgent,
  createExecuteTurn,
  isDuplicateOfLastBotFinal,
  labelPairedSenders,
} from './message-runtime-turns.js';
import { resolvePairedRoleChannels } from './message-runtime-role-channels.js';
import {
  getFreshHumanPreflightMessages,
  hasHumanMessageAfterWorkItem,
} from './message-runtime-preflight-messages.js';
import { handleMessageRuntimeAfterDeliverySuccess } from './message-runtime-after-delivery.js';
import { deliverMessageRuntimeFinalText } from './message-runtime-final-delivery.js';

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

async function deliverSessionCommandMessage(
  deps: Pick<MessageRuntimeDeps, 'channels' | 'getRoomBindings'>,
  chatJid: string,
  text: string,
): Promise<void> {
  await deliverCanonicalOutboundMessage(
    { jid: chatJid, text },
    {
      channels: deps.channels,
      roomBindings: deps.getRoomBindings,
      log: logger,
    },
  );
}

export function createMessageRuntime(deps: MessageRuntimeDeps): {
  processGroupMessages: (
    chatJid: string,
    context: GroupRunContext,
  ) => Promise<boolean>;
  recoverPendingMessages: () => void;
  startMessageLoop: () => Promise<void>;
} {
  let messageLoopRunning = false;
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

  /**
   * Check if a message is a duplicate of the last bot final message in a paired room.
   * Returns true if duplicate (should be suppressed).
   */
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

  const processGroupMessages = async (
    chatJid: string,
    context: GroupRunContext,
  ): Promise<boolean> => {
    const { runId } = context;
    const group = deps.getRoomBindings()[chatJid];
    if (!group) return true;
    const log = createScopedLogger({
      chatJid,
      groupName: group.name,
      groupFolder: group.folder,
      runId,
    });

    const channel = findChannel(deps.channels, chatJid);
    if (!channel) {
      log.warn('No channel owns JID, skipping messages');
      return true;
    }

    const {
      roleToChannel,
      reviewerChannelName,
      foundReviewerChannel,
      arbiterChannelName,
      foundArbiterChannel,
    } = resolvePairedRoleChannels(deps.channels, channel);
    if (hasReviewerLease(chatJid)) {
      log.info(
        {
          reviewerChannelName,
          foundChannel: foundReviewerChannel?.name ?? null,
          arbiterChannelName,
          foundArbiterChannel: foundArbiterChannel?.name ?? null,
          availableChannels: deps.channels.map((c) => c.name),
        },
        'Paired room reviewer/arbiter channel resolution',
      );
    }

    // Delivery retries can come from forced fallback runs whose agent_type
    // differs from the room owner's registered agent type.
    let pendingTask = hasReviewerLease(chatJid)
      ? getLatestOpenPairedTaskForChat(chatJid)
      : null;
    let openWorkItem = getOpenWorkItemForChat(chatJid, SERVICE_SESSION_SCOPE);
    if (openWorkItem?.delivery_role === 'owner' && pendingTask) {
      const freshHumanMessages = getFreshHumanPreflightMessages({
        chatJid,
        channel,
        lastAgentTimestamps: deps.getLastAgentTimestamps(),
        assistantName: deps.assistantName,
        failureFinalText: FAILURE_FINAL_TEXT,
      });
      if (
        pendingTask.status === 'merge_ready' &&
        freshHumanMessages.length > 0
      ) {
        const resolvedTask = resolveOwnerTaskForHumanMessage({
          group,
          chatJid,
          existingTask: pendingTask,
        });
        pendingTask = resolvedTask.task;
        if (resolvedTask.supersededTask) {
          markWorkItemDelivered(openWorkItem.id);
          log.info(
            {
              chatJid,
              workItemId: openWorkItem.id,
              supersededTaskId: resolvedTask.supersededTask.id,
              replacementTaskId: resolvedTask.task?.id ?? null,
            },
            'Suppressed stale owner delivery retry because a new human message superseded the merge_ready task',
          );
          openWorkItem = undefined;
        }
      } else if (
        pendingTask.status === 'active' &&
        hasHumanMessageAfterWorkItem(openWorkItem, freshHumanMessages)
      ) {
        markWorkItemDelivered(openWorkItem.id);
        log.info(
          {
            chatJid,
            workItemId: openWorkItem.id,
            taskId: pendingTask.id,
            taskStatus: pendingTask.status,
            workItemEndSeq: openWorkItem.end_seq ?? null,
            freshHumanMessageCount: freshHumanMessages.length,
          },
          'Suppressed stale owner delivery retry because a new human message arrived while the paired task was still active',
        );
        openWorkItem = undefined;
      }
    }
    const openWorkItemOutcome = await processOpenWorkItemDelivery({
      chatJid,
      runId,
      openWorkItem,
      pendingTask,
      channel,
      roleToChannel,
      log,
      attachmentBaseDirs: resolveRuntimeAttachmentBaseDirs(group),
      isPairedRoom: hasReviewerLease(chatJid),
      getMissingRoleChannelMessage,
      isDuplicateOfLastBotFinal: checkDuplicateOfLastBotFinal,
      openContinuation: (targetChatJid) =>
        continuationTracker.open(targetChatJid),
      enqueueFollowUpAfterDeliveryRetry: ({
        deliveryRole,
        pendingTask,
        workItemId,
      }) =>
        enqueueDeliveryRetryFollowUp({
          chatJid,
          runId,
          deliveryRole,
          pendingTask,
          workItemId,
          log,
          enqueueMessageCheck: () => deps.queue.enqueueMessageCheck(chatJid),
        }),
    });
    if (openWorkItemOutcome === 'failed') {
      return false;
    }
    if (openWorkItemOutcome === 'delivered') {
      return true;
    }

    while (true) {
      const sinceSeqCursor = deps.getLastAgentTimestamps()[chatJid] || '0';
      const rawMissedMessages = getMessagesSinceSeq(
        chatJid,
        sinceSeqCursor,
        deps.assistantName,
      );
      const missedMessages = filterLoopingPairedBotMessages(
        chatJid,
        getProcessableMessages(chatJid, rawMissedMessages, channel),
        FAILURE_FINAL_TEXT,
      );

      if (missedMessages.length === 0) {
        const pendingTurnOutcome = await runPendingPairedTurnIfNeeded({
          chatJid,
          group,
          runId,
          log,
          timezone: deps.timezone,
          task: hasReviewerLease(chatJid)
            ? getLatestOpenPairedTaskForChat(chatJid)
            : null,
          rawMissedMessages,
          saveState: deps.saveState,
          lastAgentTimestamps: deps.getLastAgentTimestamps(),
          executeTurn,
          getFixedRoleChannelName,
          roleToChannel,
          labelPairedSenders: labelPairedRuntimeSenders,
          mode: 'idle',
        });
        if (pendingTurnOutcome !== null) {
          return pendingTurnOutcome;
        }

        const lastIgnored = rawMissedMessages[rawMissedMessages.length - 1];
        if (lastIgnored) {
          advanceLastAgentCursor(
            deps.getLastAgentTimestamps(),
            deps.saveState,
            chatJid,
            lastIgnored.timestamp,
          );
        }
        return true;
      }

      const botOnlyPendingTurnOutcome = await runPendingPairedTurnIfNeeded({
        chatJid,
        group,
        runId,
        log,
        timezone: deps.timezone,
        task: hasReviewerLease(chatJid)
          ? getLatestOpenPairedTaskForChat(chatJid)
          : null,
        rawMissedMessages,
        saveState: deps.saveState,
        lastAgentTimestamps: deps.getLastAgentTimestamps(),
        executeTurn,
        getFixedRoleChannelName,
        roleToChannel,
        labelPairedSenders: labelPairedRuntimeSenders,
        mode: 'bot-only',
        missedMessages,
      });
      if (botOnlyPendingTurnOutcome !== null) {
        return botOnlyPendingTurnOutcome;
      }

      if (shouldSkipBotOnlyCollaboration(chatJid, missedMessages)) {
        const lastMessage = missedMessages[missedMessages.length - 1];
        if (lastMessage?.seq != null) {
          advanceLastAgentCursor(
            deps.getLastAgentTimestamps(),
            deps.saveState,
            chatJid,
            lastMessage.seq,
          );
        }
        log.info(
          'Skipping bot-only collaboration because no recent human message exists',
        );
        return true;
      }

      const gateResult = await handleQueuedRunGates({
        chatJid,
        group,
        runId,
        missedMessages,
        triggerPattern: deps.triggerPattern,
        timezone: deps.timezone,
        hasImplicitContinuationWindow: continuationTracker.has,
        sessionCommandDeps: {
          sendMessage: (text) =>
            deliverSessionCommandMessage(deps, chatJid, text),
          setTyping: (typing) =>
            channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
          runAgent: (prompt, onOutput) =>
            runAgent(group, prompt, chatJid, runId, onOutput),
          closeStdin: () =>
            deps.queue.closeStdin(chatJid, {
              reason: 'session-command',
            }),
          clearSession: (opts) => deps.clearSession(group.folder, opts),
          advanceCursor: (cursorOrTimestamp) => {
            advanceLastAgentCursor(
              deps.getLastAgentTimestamps(),
              deps.saveState,
              chatJid,
              cursorOrTimestamp,
            );
          },
          formatMessages,
          isAdminSender: (msg) => isSessionCommandSenderAllowed(msg.sender),
          canSenderInteract: () => true,
          resetPairedTask: () => {
            if (hasReviewerLease(chatJid)) {
              const task = getLatestOpenPairedTaskForChat(chatJid);
              if (task) {
                const now = new Date().toISOString();
                transitionPairedTaskStatus({
                  taskId: task.id,
                  currentStatus: task.status,
                  nextStatus: 'completed',
                  expectedUpdatedAt: task.updated_at,
                  updatedAt: now,
                  patch: {
                    completion_reason: 'stopped',
                  },
                });
              }
            }
          },
          killProcess: () => deps.queue.killProcess(chatJid),
        },
      });
      if (gateResult.handled) {
        return gateResult.success;
      }

      return runQueuedGroupTurn({
        chatJid,
        group,
        runId,
        log,
        timezone: deps.timezone,
        missedMessages,
        task: hasReviewerLease(chatJid)
          ? (getLatestOpenPairedTaskForChat(chatJid) ?? null)
          : undefined,
        roleToChannel,
        ownerChannel: channel,
        lastAgentTimestamps: deps.getLastAgentTimestamps(),
        saveState: deps.saveState,
        executeTurn,
        getFixedRoleChannelName,
        labelPairedSenders: labelPairedRuntimeSenders,
        formatMessages,
      });
    }
  };

  const startMessageLoop = async (): Promise<void> => {
    if (messageLoopRunning) {
      logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    messageLoopRunning = true;

    logger.info('EJClaw running');

    while (true) {
      try {
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
            deps.queue.getStatuses([chatJid])[0]?.runPhase ===
            'running_messages',
          labelPairedSenders: labelPairedRuntimeSenders,
        });
      } catch (err) {
        logger.error({ err }, 'Error in message loop');
      }
      await new Promise((resolve) => setTimeout(resolve, deps.pollInterval));
    }
  };

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
