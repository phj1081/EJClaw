import {
  createProducedWorkItem,
  hasActiveCiWatcherForChat,
  getOpenWorkItemForChat,
  getMessagesSinceSeq,
  getLatestOpenPairedTaskForChat,
  markWorkItemDelivered,
  getPairedTaskById,
  updatePairedTurnProgressText,
} from './db.js';
import {
  isSessionCommandSenderAllowed,
  SERVICE_SESSION_SCOPE,
} from './config.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import { findChannel, findChannelByName, formatMessages } from './router.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { enqueueGenericFollowUpAfterDeliveryRetry as enqueueDeliveryRetryFollowUp } from './message-runtime-dispatch.js';
import {
  deliverOpenWorkItem,
  processOpenWorkItemDelivery,
} from './message-runtime-delivery.js';
import { handleQueuedRunGates } from './message-runtime-gating.js';
import {
  enqueuePendingHandoffs as enqueueClaimedServiceHandoffs,
  processClaimedHandoff as processClaimedServiceHandoff,
} from './message-runtime-handoffs.js';
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
import {
  enqueuePairedFollowUpAfterEvent,
  schedulePairedFollowUpWithMessageCheck,
} from './message-runtime-follow-up.js';
import { type ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import { transitionPairedTaskStatus } from './paired-execution-context-shared.js';
import {
  Channel,
  NewMessage,
  type PairedRoomRole,
  RegisteredGroup,
  type PairedTask,
} from './types.js';
import { createScopedLogger, logger } from './logger.js';
import { hasReviewerLease } from './service-routing.js';
import type { WorkItem } from './db/work-items.js';
export {
  resolveHandoffCursorKey,
  resolveHandoffRoleOverride,
} from './message-runtime-shared.js';
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

  const getFreshHumanPreflightMessages = (
    chatJid: string,
    channel: Channel,
  ): NewMessage[] => {
    const sinceSeqCursor = deps.getLastAgentTimestamps()[chatJid] || '0';
    const preflightRawMessages = getMessagesSinceSeq(
      chatJid,
      sinceSeqCursor,
      deps.assistantName,
    );
    const preflightMessages = filterLoopingPairedBotMessages(
      chatJid,
      getProcessableMessages(chatJid, preflightRawMessages, channel),
      FAILURE_FINAL_TEXT,
    );
    return preflightMessages.filter(
      (message) => message.is_from_me !== true && !message.is_bot_message,
    );
  };

  const hasHumanMessageAfterWorkItem = (
    openWorkItem: WorkItem,
    freshHumanMessages: NewMessage[],
  ): boolean => {
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
  };

  const scheduleQueuedPairedFollowUp = (args: {
    chatJid: string;
    runId: string;
    task: PairedTask | null | undefined;
    intentKind: ScheduledPairedFollowUpIntentKind;
    enqueue: () => void;
    fallbackLastTurnOutputRole?: PairedRoomRole | null;
  }): boolean =>
    schedulePairedFollowUpWithMessageCheck({
      chatJid: args.chatJid,
      runId: args.runId,
      task: args.task,
      intentKind: args.intentKind,
      enqueueMessageCheck: args.enqueue,
      fallbackLastTurnOutputRole: args.fallbackLastTurnOutputRole,
    });

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
      if (
        (deliveryRole === 'reviewer' || deliveryRole === 'arbiter') &&
        deps.queue.hasDirectTerminalDeliveryForRun?.(
          chatJid,
          runId,
          deliveryRole,
        )
      ) {
        logger.info(
          {
            chatJid,
            runId,
            deliveryRole,
          },
          'Skipping final work item delivery because this run already sent a direct terminal IPC message',
        );
        return true;
      }
      const workItem = createProducedWorkItem({
        group_folder: group.folder,
        chat_jid: chatJid,
        agent_type: forcedAgentType ?? group.agentType ?? 'claude-code',
        service_id: deliveryServiceId ?? undefined,
        delivery_role: deliveryRole,
        start_seq: startSeq,
        end_seq: endSeq,
        result_payload: text,
        attachments,
      });
      return deliverOpenWorkItem({
        channel,
        item: workItem,
        log: logger,
        attachmentBaseDirs: group.workDir ? [group.workDir] : undefined,
        replaceMessageId,
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
      if (!deliveryRole || !pairedRoom) {
        return;
      }
      const pendingTaskAfterDelivery = getLatestOpenPairedTaskForChat(chatJid);
      if (
        deliveryRole === 'owner' &&
        pendingTaskAfterDelivery?.status === 'review_ready' &&
        hasActiveCiWatcherForChat(chatJid)
      ) {
        logger.info(
          {
            chatJid,
            runId,
            completedRole: deliveryRole,
            taskId: pendingTaskAfterDelivery.id,
            taskStatus: pendingTaskAfterDelivery.status,
          },
          'Deferred paired follow-up after successful owner delivery because CI watcher is still active',
        );
        return;
      }
      const followUpResult = enqueuePairedFollowUpAfterEvent({
        chatJid,
        runId,
        task: pendingTaskAfterDelivery,
        source: 'delivery-success',
        completedRole: deliveryRole,
        fallbackLastTurnOutputRole: deliveryRole,
        enqueueMessageCheck: () => deps.queue.enqueueMessageCheck(chatJid),
      });
      if (followUpResult.kind === 'paired-follow-up') {
        logger.info(
          {
            chatJid,
            runId,
            completedRole: deliveryRole,
            taskId: followUpResult.taskId,
            taskStatus: followUpResult.taskStatus,
            intentKind: followUpResult.intentKind,
            scheduled: followUpResult.scheduled,
          },
          followUpResult.scheduled
            ? deliveryRole === 'owner'
              ? 'Queued paired follow-up after successful owner delivery'
              : 'Queued paired follow-up after successful reviewer/arbiter delivery'
            : deliveryRole === 'owner'
              ? 'Skipped duplicate paired follow-up after successful owner delivery while task state was unchanged'
              : 'Skipped duplicate paired follow-up after successful reviewer/arbiter delivery while task state was unchanged',
        );
      }
    },
  });

  const enqueuePendingHandoffs = (): void => {
    enqueueClaimedServiceHandoffs({
      enqueueTask: (chatJid, taskId, task) => {
        deps.queue.enqueueTask?.(chatJid, taskId, task);
      },
      processClaimedHandoff: async (handoff) => {
        await processClaimedServiceHandoff({
          handoff,
          getRoomBindings: deps.getRoomBindings,
          channels: deps.channels,
          executeTurn,
          lastAgentTimestamps: deps.getLastAgentTimestamps(),
          saveState: deps.saveState,
          getPairedTaskById,
          enqueueMessageCheck: (chatJid) =>
            deps.queue.enqueueMessageCheck(chatJid),
        });
      },
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

    // For paired rooms, reviewer/arbiter outputs use their fixed role bots.
    const reviewerChannelName = 'discord-review';
    const foundReviewerChannel = findChannelByName(
      deps.channels,
      reviewerChannelName,
    );

    const arbiterChannelName = 'discord-arbiter';
    const foundArbiterChannel = findChannelByName(
      deps.channels,
      arbiterChannelName,
    );

    // Resolve the correct Discord channel for a given task status.
    const roleToChannel: Record<
      'owner' | 'reviewer' | 'arbiter',
      Channel | null
    > = {
      owner: channel,
      reviewer: foundReviewerChannel || null,
      arbiter: foundArbiterChannel || null,
    };
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
      const freshHumanMessages = getFreshHumanPreflightMessages(
        chatJid,
        channel,
      );
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
      attachmentBaseDirs: group.workDir ? [group.workDir] : undefined,
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

    const isMainGroup = group.isMain === true;
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
          sendMessage: (text) => channel.sendMessage(chatJid, text),
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
          ? getLatestOpenPairedTaskForChat(chatJid)
          : null,
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
          scheduleQueuedPairedFollowUp,
          enqueueScopedGroupMessageCheck,
          sendQueuedMessage: deps.queue.sendMessage.bind(deps.queue),
          closeStdin: (chatJid, reason) =>
            deps.queue.closeStdin(chatJid, {
              reason,
            }),
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
