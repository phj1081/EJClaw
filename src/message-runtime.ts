import { AgentOutput } from './agent-runner.js';
import { getAgentOutputText } from './agent-output.js';
import {
  createProducedWorkItem,
  getOpenWorkItemForChat,
  getMessagesSinceSeq,
  getLastBotFinalMessage,
  getLatestOpenPairedTaskForChat,
  getPairedTaskById,
} from './db.js';
import {
  isSessionCommandSenderAllowed,
  SERVICE_SESSION_SCOPE,
} from './config.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import {
  findChannel,
  findChannelByName,
  formatMessages,
  normalizeMessageForDedupe,
} from './router.js';
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
import {
  enqueuePairedFollowUpAfterEvent,
  schedulePairedFollowUpWithMessageCheck,
} from './message-runtime-follow-up.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { MessageTurnController } from './message-turn-controller.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';
import { type ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import { transitionPairedTaskStatus } from './paired-execution-context-shared.js';
import {
  Channel,
  NewMessage,
  type AgentType,
  type PairedRoomRole,
  RegisteredGroup,
  type PairedTask,
} from './types.js';
import { createScopedLogger, logger } from './logger.js';
import {
  getEffectiveChannelLease,
  hasReviewerLease,
  resolveLeaseServiceId,
} from './service-routing.js';
export {
  resolveHandoffCursorKey,
  resolveHandoffRoleOverride,
} from './message-runtime-shared.js';
import {
  getFixedRoleChannelName,
  getMissingRoleChannelMessage,
} from './message-runtime-shared.js';

/**
 * Check if a message is a duplicate of the last bot final message in a paired room.
 * Exported for testing purposes.
 */
export function isDuplicateOfLastBotFinal(
  chatJid: string,
  text: string,
): boolean {
  if (!hasReviewerLease(chatJid)) {
    return false;
  }

  // Get the last bot final message from DB (any bot, not just this service)
  const lastMessages = getLastBotFinalMessage(chatJid, 'claude-code', 1);
  if (lastMessages.length === 0) {
    return false;
  }

  const lastMessage = lastMessages[0];
  const normalizedLast = normalizeMessageForDedupe(lastMessage.content);
  const normalizedCurrent = normalizeMessageForDedupe(text);

  return normalizedLast === normalizedCurrent && normalizedLast.length > 0;
}

export interface MessageRuntimeDeps {
  assistantName: string;
  idleTimeout: number;
  pollInterval: number;
  timezone: string;
  triggerPattern: RegExp;
  channels: Channel[];
  queue: GroupQueue;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
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
  // In paired rooms, replace bot sender_name with role label so agents
  // know who is the owner and who is the reviewer regardless of bot nickname.
  const labelPairedSenders = (
    chatJid: string,
    messages: NewMessage[],
  ): NewMessage[] => {
    if (!hasReviewerLease(chatJid)) return messages;
    // Build bot-user-id → channel-name mapping from connected channels
    const botIdToChannelName = new Map<string, string>();
    for (const ch of deps.channels) {
      if (!ch.isConnected()) continue;
      // Probe each bot message to find which channel owns it
      for (const msg of messages) {
        if (msg.is_bot_message && ch.isOwnMessage?.(msg)) {
          botIdToChannelName.set(msg.sender, ch.name);
        }
      }
    }
    const channelToRole: Record<string, PairedRoomRole> = {
      discord: 'owner',
      'discord-review': 'reviewer',
      'discord-arbiter': 'arbiter',
    };
    return messages.map((msg) => {
      if (!msg.is_bot_message) return msg;
      const channelName = botIdToChannelName.get(msg.sender);
      if (!channelName) return msg;
      const role = channelToRole[channelName];
      return role ? { ...msg, sender_name: role } : msg;
    });
  };

  const enqueueScopedGroupMessageCheck = buildScopedMessageCheckEnqueuer(
    deps.queue,
  );

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

  const runAgent = async (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    runId: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
    options?: {
      startSeq?: number | null;
      endSeq?: number | null;
      hasHumanMessage?: boolean;
      forcedRole?: PairedRoomRole;
      forcedAgentType?: AgentType;
      pairedTurnIdentity?: PairedTurnIdentity;
    },
  ): Promise<'success' | 'error'> =>
    runAgentForGroup(
      {
        assistantName: deps.assistantName,
        queue: deps.queue,
        getRegisteredGroups: deps.getRegisteredGroups,
        getSessions: deps.getSessions,
        persistSession: deps.persistSession,
        clearSession: deps.clearSession,
      },
      {
        group,
        prompt,
        chatJid,
        runId,
        startSeq: options?.startSeq,
        endSeq: options?.endSeq,
        hasHumanMessage: options?.hasHumanMessage,
        forcedRole: options?.forcedRole,
        forcedAgentType: options?.forcedAgentType,
        pairedTurnIdentity: options?.pairedTurnIdentity,
        onOutput,
      },
    );

  const executeTurn = async (args: {
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
    pairedTurnIdentity?: PairedTurnIdentity;
  }): Promise<{
    outputStatus: 'success' | 'error';
    deliverySucceeded: boolean;
    visiblePhase: ReturnType<MessageTurnController['finish']> extends Promise<
      infer T
    >
      ? T extends { visiblePhase: infer V }
        ? V
        : never
      : never;
  }> => {
    const { group, prompt, chatJid, runId, channel, startSeq, endSeq } = args;
    const isClaudeCodeAgent =
      (args.forcedAgentType ?? group.agentType ?? 'claude-code') ===
      'claude-code';
    const pairedRoom = hasReviewerLease(chatJid);
    const resolvedDeliveryRole =
      args.deliveryRole ?? args.forcedRole ?? (pairedRoom ? 'owner' : null);
    const turnController = new MessageTurnController({
      chatJid,
      group,
      runId,
      channel,
      idleTimeout: deps.idleTimeout,
      failureFinalText: FAILURE_FINAL_TEXT,
      isClaudeCodeAgent,
      clearSession: () => deps.clearSession(group.folder),
      requestClose: (reason) =>
        deps.queue.closeStdin(chatJid, { runId, reason }),
      deliverFinalText: async (text) => {
        try {
          const persistedDeliveryRole = resolvedDeliveryRole;
          const persistedDeliveryServiceId = resolveLeaseServiceId(
            getEffectiveChannelLease(chatJid),
            persistedDeliveryRole ?? 'owner',
          );
          if (
            (persistedDeliveryRole === 'reviewer' ||
              persistedDeliveryRole === 'arbiter') &&
            deps.queue.hasDirectTerminalDeliveryForRun?.(
              chatJid,
              runId,
              persistedDeliveryRole,
            )
          ) {
            logger.info(
              {
                chatJid,
                runId,
                deliveryRole: persistedDeliveryRole,
              },
              'Skipping final work item delivery because this run already sent a direct terminal IPC message',
            );
            return true;
          }
          const workItem = createProducedWorkItem({
            group_folder: group.folder,
            chat_jid: chatJid,
            agent_type:
              args.forcedAgentType ?? group.agentType ?? 'claude-code',
            service_id: persistedDeliveryServiceId ?? undefined,
            delivery_role: persistedDeliveryRole,
            start_seq: startSeq,
            end_seq: endSeq,
            result_payload: text,
          });
          return deliverOpenWorkItem({
            channel,
            item: workItem,
            log: logger,
            isDuplicateOfLastBotFinal: checkDuplicateOfLastBotFinal,
            openContinuation: (targetChatJid) =>
              continuationTracker.open(targetChatJid),
          });
        } catch (err) {
          logger.warn(
            { group: group.name, chatJid, runId, err },
            'Failed to persist produced output for delivery',
          );
          return false;
        }
      },
    });

    await turnController.start();

    try {
      const outputStatus = await runAgent(
        group,
        prompt,
        chatJid,
        runId,
        async (result) => {
          await turnController.handleOutput(result);
        },
        {
          startSeq,
          endSeq,
          hasHumanMessage: args.hasHumanMessage,
          forcedRole: args.forcedRole,
          forcedAgentType: args.forcedAgentType,
          pairedTurnIdentity: args.pairedTurnIdentity,
        },
      );

      const { deliverySucceeded, visiblePhase } =
        await turnController.finish(outputStatus);

      if (deliverySucceeded && pairedRoom && resolvedDeliveryRole) {
        const pendingTaskAfterDelivery =
          getLatestOpenPairedTaskForChat(chatJid);
        const followUpResult = enqueuePairedFollowUpAfterEvent({
          chatJid,
          runId,
          task: pendingTaskAfterDelivery,
          source: 'delivery-success',
          completedRole: resolvedDeliveryRole,
          fallbackLastTurnOutputRole: resolvedDeliveryRole,
          enqueueMessageCheck: () => deps.queue.enqueueMessageCheck(chatJid),
        });
        if (followUpResult.kind === 'paired-follow-up') {
          logger.info(
            {
              chatJid,
              runId,
              completedRole: resolvedDeliveryRole,
              taskId: followUpResult.taskId,
              taskStatus: followUpResult.taskStatus,
              intentKind: followUpResult.intentKind,
              scheduled: followUpResult.scheduled,
            },
            followUpResult.scheduled
              ? resolvedDeliveryRole === 'owner'
                ? 'Queued paired follow-up after successful owner delivery'
                : 'Queued paired follow-up after successful reviewer/arbiter delivery'
              : resolvedDeliveryRole === 'owner'
                ? 'Skipped duplicate paired follow-up after successful owner delivery while task state was unchanged'
                : 'Skipped duplicate paired follow-up after successful reviewer/arbiter delivery while task state was unchanged',
          );
        }
      }

      return {
        outputStatus,
        deliverySucceeded,
        visiblePhase,
      };
    } finally {
      turnController.cancelPendingTypingDelay();
      logger.debug(
        {
          transition: 'typing:off',
          source: 'message-runtime:safety-net',
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
        },
        'Typing indicator transition',
      );
      await channel.setTyping?.(chatJid, false);
    }
  };

  const enqueuePendingHandoffs = (): void => {
    enqueueClaimedServiceHandoffs({
      enqueueTask: (chatJid, taskId, task) => {
        deps.queue.enqueueTask?.(chatJid, taskId, task);
      },
      processClaimedHandoff: async (handoff) => {
        await processClaimedServiceHandoff({
          handoff,
          getRegisteredGroups: deps.getRegisteredGroups,
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
    const group = deps.getRegisteredGroups()[chatJid];
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
    const openWorkItem = getOpenWorkItemForChat(chatJid, SERVICE_SESSION_SCOPE);
    const openWorkItemOutcome = await processOpenWorkItemDelivery({
      chatJid,
      runId,
      openWorkItem,
      pendingTask: hasReviewerLease(chatJid)
        ? getLatestOpenPairedTaskForChat(chatJid)
        : null,
      channel,
      roleToChannel,
      log,
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
          labelPairedSenders,
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
        labelPairedSenders,
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
          canSenderInteract: (msg) => {
            const hasTrigger = deps.triggerPattern.test(msg.content.trim());
            const requiresTrigger =
              !isMainGroup && group.requiresTrigger !== false;
            return (
              isMainGroup ||
              !requiresTrigger ||
              (hasTrigger &&
                (msg.is_from_me ||
                  isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
            );
          },
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
        labelPairedSenders,
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

    logger.info(`EJClaw running (trigger: @${deps.assistantName})`);

    while (true) {
      try {
        await processMessageLoopTick({
          assistantName: deps.assistantName,
          failureFinalText: FAILURE_FINAL_TEXT,
          triggerPattern: deps.triggerPattern,
          timezone: deps.timezone,
          channels: deps.channels,
          getRegisteredGroups: deps.getRegisteredGroups,
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
          labelPairedSenders,
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
      getRegisteredGroups: deps.getRegisteredGroups,
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
