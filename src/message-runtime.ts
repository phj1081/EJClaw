import { AgentOutput } from './agent-runner.js';
import { getAgentOutputText } from './agent-output.js';
import { getErrorMessage } from './utils.js';
import {
  claimServiceHandoff,
  completeServiceHandoffAndAdvanceTargetCursor,
  createProducedWorkItem,
  failServiceHandoff,
  getAllPendingServiceHandoffs,
  getOpenWorkItemForChat,
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  getLastBotFinalMessage,
  getLastHumanMessageContent,
  getRecentChatMessages,
  getLatestOpenPairedTaskForChat,
  getPairedTurnOutputs,
  updatePairedTask,
  type ServiceHandoff,
  type WorkItem,
} from './db.js';
import { isSessionCommandSenderAllowed } from './config.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import {
  findChannel,
  findChannelByName,
  formatMessages,
  normalizeMessageForDedupe,
} from './router.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import {
  advanceLastAgentCursor,
  createImplicitContinuationTracker,
  resolveNextTurnAction,
  resolveActiveRole,
  resolveCursorKey,
  filterLoopingPairedBotMessages,
  getProcessableMessages,
  hasAllowedTrigger,
  shouldSkipBotOnlyCollaboration,
} from './message-runtime-rules.js';
import { runAgentForGroup } from './message-agent-executor.js';
import {
  buildQueuedTurnDispatch,
  buildPendingPairedTurn,
  executeBotOnlyPairedFollowUpAction,
  executePendingPairedTurn,
  isBotOnlyPairedRoomTurn,
  shouldSkipGenericFollowUpAfterDeliveryRetry,
} from './message-runtime-flow.js';
import { MessageTurnController } from './message-turn-controller.js';
import {
  buildArbiterPromptForTask,
  buildFinalizePendingPrompt,
  buildOwnerPendingPrompt,
  buildPairedTurnPrompt,
  buildReviewerPendingPrompt,
} from './message-runtime-prompts.js';
import { transitionPairedTaskStatus } from './paired-execution-context-shared.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
  isSessionCommandControlMessage,
} from './session-commands.js';
import {
  Channel,
  NewMessage,
  type AgentType,
  type PairedRoomRole,
  RegisteredGroup,
  type PairedTask,
} from './types.js';
import { createScopedLogger, logger } from './logger.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { hasReviewerLease } from './service-routing.js';

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

export function resolveHandoffRoleOverride(
  handoff: Pick<ServiceHandoff, 'target_role' | 'intended_role' | 'reason'>,
): PairedRoomRole | undefined {
  if (handoff.target_role) {
    return handoff.target_role;
  }
  if (handoff.intended_role) {
    return handoff.intended_role;
  }
  if (handoff.reason?.startsWith('reviewer-')) {
    return 'reviewer';
  }
  if (handoff.reason?.startsWith('arbiter-')) {
    return 'arbiter';
  }
  return undefined;
}

export function resolveHandoffCursorKey(
  chatJid: string,
  role?: PairedRoomRole,
): string {
  if (!role || role === 'owner') {
    return chatJid;
  }
  return `${chatJid}:${role}`;
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

function getFixedRoleChannelName(role: 'reviewer' | 'arbiter'): string {
  return role === 'reviewer' ? 'discord-review' : 'discord-arbiter';
}

function getMissingRoleChannelMessage(role: 'reviewer' | 'arbiter'): string {
  return `Missing configured ${role} Discord bot channel (${getFixedRoleChannelName(role)}) for role-fixed delivery`;
}

function isTerminalStatusMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return /^(?:\*\*)?(DONE(?:_WITH_CONCERNS)?|BLOCKED|NEEDS_CONTEXT)\b/.test(
    trimmed,
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

  const enqueueScopedGroupMessageCheck = (
    chatJid: string,
    groupFolder: string,
  ): void => {
    deps.queue.enqueueMessageCheck(chatJid, resolveGroupIpcPath(groupFolder));
  };

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

  const buildDeliveryLogContext = (
    channel: Channel,
    item: WorkItem,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    chatJid: item.chat_jid,
    channelName: channel.name,
    workItemId: item.id,
    deliveryRole: item.delivery_role ?? null,
    ...extra,
  });

  const deliverOpenWorkItem = async (
    channel: Channel,
    item: WorkItem,
    options?: {
      replaceMessageId?: string | null;
    },
  ): Promise<boolean> => {
    const replaceMessageId = options?.replaceMessageId ?? null;

    // Check for duplicate in paired rooms before attempting delivery
    const isDuplicate = checkDuplicateOfLastBotFinal(
      item.chat_jid,
      item.result_payload,
    );

    if (isDuplicate) {
      // Mark as delivered without sending, and don't open continuation
      markWorkItemDelivered(item.id, null);
      logger.info(
        buildDeliveryLogContext(channel, item, {
          preview: item.result_payload.slice(0, 100),
          suppressionReason: 'paired-final-duplicate',
        }),
        'Suppressed duplicate final message in paired room (marked as delivered)',
      );
      return true;
    }

    try {
      if (replaceMessageId && channel.editMessage) {
        logger.info(
          buildDeliveryLogContext(channel, item, {
            deliveryAttempts: item.delivery_attempts + 1,
            deliveryMode: 'edit',
            replacedMessageId: replaceMessageId,
          }),
          'Attempting to deliver produced work item by replacing tracked progress message',
        );
        await channel.editMessage(
          item.chat_jid,
          replaceMessageId,
          item.result_payload,
        );
        markWorkItemDelivered(item.id, replaceMessageId);
        continuationTracker.open(item.chat_jid);
        logger.info(
          buildDeliveryLogContext(channel, item, {
            deliveryAttempts: item.delivery_attempts + 1,
            deliveryMode: 'edit',
            replacedMessageId: replaceMessageId,
          }),
          'Delivered produced work item by replacing tracked progress message',
        );
        return true;
      }
    } catch (err) {
      logger.warn(
        buildDeliveryLogContext(channel, item, {
          deliveryAttempts: item.delivery_attempts + 1,
          deliveryMode: 'edit',
          replacedMessageId: replaceMessageId,
          err,
        }),
        'Failed to replace tracked progress message; falling back to a new message',
      );
    }

    try {
      logger.info(
        buildDeliveryLogContext(channel, item, {
          deliveryAttempts: item.delivery_attempts + 1,
          deliveryMode: 'send',
        }),
        'Attempting to deliver produced work item as a new message',
      );
      await channel.sendMessage(item.chat_jid, item.result_payload);
      markWorkItemDelivered(item.id);
      continuationTracker.open(item.chat_jid);
      logger.info(
        buildDeliveryLogContext(channel, item, {
          deliveryAttempts: item.delivery_attempts + 1,
          deliveryMode: 'send',
        }),
        'Delivered produced work item',
      );
      return true;
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      markWorkItemDeliveryRetry(item.id, errorMessage);
      logger.warn(
        buildDeliveryLogContext(channel, item, {
          deliveryAttempts: item.delivery_attempts + 1,
          deliveryMode: 'send',
          err,
        }),
        'Failed to deliver produced work item',
      );
      return false;
    }
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
          const persistedDeliveryRole =
            args.deliveryRole ??
            args.forcedRole ??
            (hasReviewerLease(chatJid) ? 'owner' : null);
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
            delivery_role: persistedDeliveryRole,
            start_seq: startSeq,
            end_seq: endSeq,
            result_payload: text,
          });
          return deliverOpenWorkItem(channel, workItem);
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
        },
      );

      const { deliverySucceeded, visiblePhase } =
        await turnController.finish(outputStatus);

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
    // Unified runtime claims pending handoffs once and resolves delivery from role context.
    for (const handoff of getAllPendingServiceHandoffs()) {
      if (!claimServiceHandoff(handoff.id)) {
        continue;
      }

      deps.queue.enqueueTask(
        handoff.chat_jid,
        `handoff:${handoff.id}`,
        async () => {
          await processClaimedHandoff(handoff);
        },
      );
    }
  };

  const processClaimedHandoff = async (
    handoff: ServiceHandoff,
  ): Promise<void> => {
    const group = deps.getRegisteredGroups()[handoff.chat_jid];
    if (!group) {
      failServiceHandoff(handoff.id, 'Group not registered on target service');
      return;
    }

    const channel = findChannel(deps.channels, handoff.chat_jid);
    if (!channel) {
      failServiceHandoff(handoff.id, 'No channel owns handoff jid');
      return;
    }

    // Reviewer/arbiter failover handoffs should run via the appropriate
    // channel so they execute in the correct role mode.
    const handoffRole = resolveHandoffRoleOverride(handoff);
    let handoffChannel = channel;
    if (handoffRole === 'reviewer') {
      // Role-fixed delivery intentionally does not follow fallback agent type.
      const reviewerChannel = findChannelByName(
        deps.channels,
        getFixedRoleChannelName('reviewer'),
      );
      if (!reviewerChannel) {
        failServiceHandoff(
          handoff.id,
          getMissingRoleChannelMessage('reviewer'),
        );
        return;
      }
      handoffChannel = reviewerChannel;
    } else if (handoffRole === 'arbiter') {
      const arbiterChannel = findChannelByName(
        deps.channels,
        getFixedRoleChannelName('arbiter'),
      );
      if (!arbiterChannel) {
        failServiceHandoff(handoff.id, getMissingRoleChannelMessage('arbiter'));
        return;
      }
      handoffChannel = arbiterChannel;
    }

    const runId = `handoff-${handoff.id}`;
    try {
      logger.info(
        {
          chatJid: handoff.chat_jid,
          handoffId: handoff.id,
          runId,
          handoffRole,
          targetRole: handoff.target_role ?? null,
          targetServiceId: handoff.target_service_id,
          targetAgentType: handoff.target_agent_type,
          reason: handoff.reason,
          intendedRole: handoff.intended_role ?? null,
          channelName: handoffChannel.name,
        },
        'Dispatching claimed service handoff',
      );
      const result = await executeTurn({
        group,
        prompt: handoff.prompt,
        chatJid: handoff.chat_jid,
        runId,
        channel: handoffChannel,
        startSeq: handoff.start_seq,
        endSeq: handoff.end_seq,
        forcedRole: handoffRole,
        forcedAgentType: handoff.target_agent_type,
      });

      if (!result.deliverySucceeded) {
        failServiceHandoff(handoff.id, 'Handoff delivery failed');
        return;
      }

      const cursorKey = resolveHandoffCursorKey(handoff.chat_jid, handoffRole);
      const appliedCursor = completeServiceHandoffAndAdvanceTargetCursor({
        id: handoff.id,
        chat_jid: handoff.chat_jid,
        cursor_key: cursorKey,
        end_seq: handoff.end_seq,
      });
      if (appliedCursor) {
        deps.getLastAgentTimestamps()[cursorKey] = appliedCursor;
        deps.saveState();
      }
      logger.info(
        {
          chatJid: handoff.chat_jid,
          handoffId: handoff.id,
          runId,
          outputStatus: result.outputStatus,
          visiblePhase: result.visiblePhase,
          appliedCursor,
          cursorKey:
            appliedCursor != null
              ? resolveHandoffCursorKey(handoff.chat_jid, handoffRole)
              : null,
        },
        'Completed claimed service handoff',
      );
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      failServiceHandoff(handoff.id, errorMessage);
      logger.error(
        { chatJid: handoff.chat_jid, handoffId: handoff.id, err },
        'Claimed service handoff failed',
      );
    }
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
    const roleToChannel: Record<string, Channel | null> = {
      owner: channel,
      reviewer: foundReviewerChannel || null,
      arbiter: foundArbiterChannel || null,
    };
    const resolveChannel = (taskStatus?: string | null): Channel | null => {
      const role = resolveActiveRole(taskStatus);
      return role === 'owner' ? channel : roleToChannel[role];
    };

    const enqueueGroupMessageCheck = (): void => {
      enqueueScopedGroupMessageCheck(chatJid, group.folder);
    };

    const enqueueGenericFollowUpAfterDeliveryRetry = (args: {
      deliveryRole: PairedRoomRole;
      pendingTask: PairedTask | null | undefined;
      workItemId: string | number;
    }): void => {
      if (
        shouldSkipGenericFollowUpAfterDeliveryRetry({
          chatJid,
          deliveryRole: args.deliveryRole,
          pendingTask: args.pendingTask,
        })
      ) {
        log.info(
          {
            workItemId: args.workItemId,
            chatJid,
            deliveryRole: args.deliveryRole,
            pendingTaskStatus: args.pendingTask?.status ?? null,
          },
          'Skipping queued follow-up after reviewer merge_ready delivery because inline finalize will handle the handoff',
        );
        return;
      }
      deps.queue.enqueueMessageCheck(chatJid);
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
    const openWorkItem = getOpenWorkItemForChat(chatJid);
    if (openWorkItem) {
      const pendingTask = hasReviewerLease(chatJid)
        ? getLatestOpenPairedTaskForChat(chatJid)
        : null;
      if (hasReviewerLease(chatJid) && openWorkItem.delivery_role == null) {
        log.warn(
          {
            workItemId: openWorkItem.id,
            chatJid,
            pendingTaskStatus: pendingTask?.status ?? null,
          },
          'Paired-room delivery retry is missing a persisted delivery role; falling back to inferred routing',
        );
      }
      const deliveryRole =
        openWorkItem.delivery_role ??
        (pendingTask ? resolveActiveRole(pendingTask.status) : 'owner');
      const deliveryChannel =
        deliveryRole === 'owner' ? channel : roleToChannel[deliveryRole];
      if (!deliveryChannel) {
        const missingRole = deliveryRole === 'arbiter' ? 'arbiter' : 'reviewer';
        const errorMessage = getMissingRoleChannelMessage(missingRole);
        markWorkItemDeliveryRetry(openWorkItem.id, errorMessage);
        log.error(
          {
            workItemId: openWorkItem.id,
            role: deliveryRole,
            requiredChannel: getFixedRoleChannelName(missingRole),
          },
          'Unable to deliver paired-room work item because the dedicated Discord role channel is not configured',
        );
        return false;
      }
      const delivered = await deliverOpenWorkItem(
        deliveryChannel,
        openWorkItem,
      );
      if (!delivered) return false;
      enqueueGenericFollowUpAfterDeliveryRetry({
        deliveryRole,
        pendingTask,
        workItemId: openWorkItem.id,
      });
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
        // Check if a paired review is pending — run reviewer even without new messages
        const pendingReviewTask = hasReviewerLease(chatJid)
          ? getLatestOpenPairedTaskForChat(chatJid)
          : null;
        const pendingTurn = pendingReviewTask
          ? buildPendingPairedTurn({
              chatJid,
              timezone: deps.timezone,
              task: pendingReviewTask,
              rawMissedMessages,
              recentHumanMessages: getRecentChatMessages(chatJid, 20).filter(
                (message) => !message.is_bot_message,
              ),
              labeledRecentMessages: labelPairedSenders(
                chatJid,
                getRecentChatMessages(chatJid, 20),
              ),
              resolveChannel,
            })
          : null;
        if (pendingTurn) {
          return executePendingPairedTurn({
            pendingTurn,
            chatJid,
            group,
            runId,
            log,
            saveState: deps.saveState,
            lastAgentTimestamps: deps.getLastAgentTimestamps(),
            executeTurn,
            getFixedRoleChannelName,
          });
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

      const botOnlyPendingTask = hasReviewerLease(chatJid)
        ? getLatestOpenPairedTaskForChat(chatJid)
        : null;
      const botOnlyPendingTurn =
        botOnlyPendingTask && isBotOnlyPairedRoomTurn(chatJid, missedMessages)
          ? buildPendingPairedTurn({
              chatJid,
              timezone: deps.timezone,
              task: botOnlyPendingTask,
              rawMissedMessages,
              recentHumanMessages: getRecentChatMessages(chatJid, 20).filter(
                (message) => !message.is_bot_message,
              ),
              labeledRecentMessages: labelPairedSenders(
                chatJid,
                getRecentChatMessages(chatJid, 20),
              ),
              resolveChannel,
            })
          : null;
      if (botOnlyPendingTurn) {
        return executePendingPairedTurn({
          pendingTurn: botOnlyPendingTurn,
          chatJid,
          group,
          runId,
          log,
          saveState: deps.saveState,
          lastAgentTimestamps: deps.getLastAgentTimestamps(),
          executeTurn,
          getFixedRoleChannelName,
        });
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

      const cmdResult = await handleSessionCommand({
        missedMessages,
        isMainGroup,
        groupName: group.name,
        runId,
        triggerPattern: deps.triggerPattern,
        timezone: deps.timezone,
        deps: {
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
      if (cmdResult.handled) return cmdResult.success;

      if (
        !hasAllowedTrigger({
          chatJid,
          messages: missedMessages,
          group,
          triggerPattern: deps.triggerPattern,
          hasImplicitContinuationWindow: continuationTracker.has,
        })
      ) {
        log.info('Skipping queued run because no allowed trigger was found');
        return true;
      }

      // Determine role BEFORE advancing cursor — paired rooms use
      // separate cursors for owner and reviewer so neither misses
      // the other's messages.
      const pendingTaskForChannel = hasReviewerLease(chatJid)
        ? getLatestOpenPairedTaskForChat(chatJid)
        : null;
      const taskStatus = pendingTaskForChannel?.status;
      const turnChannel = resolveChannel(taskStatus);
      const cursorKey = resolveCursorKey(chatJid, taskStatus);

      // Arbiter turns use a dedicated context prompt; regular turns use formatted messages.
      const turnRole = resolveActiveRole(taskStatus);
      let prompt: string;
      if (turnRole === 'arbiter' && pendingTaskForChannel) {
        const recentMessages = getRecentChatMessages(chatJid, 20);
        prompt = buildArbiterPromptForTask({
          task: pendingTaskForChannel,
          chatJid,
          timezone: deps.timezone,
          turnOutputs: getPairedTurnOutputs(pendingTaskForChannel.id),
          recentMessages,
          labeledRecentMessages: labelPairedSenders(chatJid, recentMessages),
        });
      } else if (pendingTaskForChannel) {
        prompt = buildPairedTurnPrompt({
          taskId: pendingTaskForChannel.id,
          chatJid,
          timezone: deps.timezone,
          missedMessages,
          labeledFallbackMessages: labelPairedSenders(chatJid, missedMessages),
          turnOutputs: getPairedTurnOutputs(pendingTaskForChannel.id),
        });
      } else {
        prompt = formatMessages(
          labelPairedSenders(chatJid, missedMessages),
          deps.timezone,
        );
      }
      const startSeq = missedMessages[0].seq ?? null;
      const endSeq = missedMessages[missedMessages.length - 1].seq ?? null;
      log.info(
        {
          messageCount: missedMessages.length,
          messageSeqStart: startSeq,
          messageSeqEnd: endSeq,
        },
        'Dispatching queued messages to agent',
      );

      if (!turnChannel) {
        const missingRole = turnRole === 'arbiter' ? 'arbiter' : 'reviewer';
        log.error(
          {
            taskStatus,
            role: turnRole,
            requiredChannel: getFixedRoleChannelName(missingRole),
          },
          'Skipping paired-room run because the dedicated Discord role channel is not configured',
        );
        return false;
      }

      if (endSeq !== null) {
        advanceLastAgentCursor(
          deps.getLastAgentTimestamps(),
          deps.saveState,
          chatJid,
          endSeq,
          cursorKey,
        );
      }

      const hasHumanMsg = !isBotOnlyPairedRoomTurn(chatJid, missedMessages);
      const { deliverySucceeded, visiblePhase } = await executeTurn({
        group,
        prompt,
        chatJid,
        runId,
        channel: turnChannel,
        deliveryRole: pendingTaskForChannel ? turnRole : undefined,
        startSeq,
        endSeq,
        hasHumanMessage: hasHumanMsg,
      });

      if (!deliverySucceeded) {
        log.warn(
          {
            messageSeqStart: startSeq,
            messageSeqEnd: endSeq,
          },
          'Persisted produced output for delivery retry without rerunning agent',
        );
        return false;
      }

      log.info(
        {
          visiblePhase,
          messageSeqStart: startSeq,
          messageSeqEnd: endSeq,
        },
        'Queued run completed successfully',
      );

      return true;
    }
  };

  const processQueuedGroupDispatch = async (args: {
    chatJid: string;
    group: RegisteredGroup;
    channel: Channel;
    processableGroupMessages: NewMessage[];
  }): Promise<void> => {
    const { chatJid, group, channel, processableGroupMessages } = args;
    const loopPendingTask = hasReviewerLease(chatJid)
      ? getLatestOpenPairedTaskForChat(chatJid)
      : null;
    const loopCursorKey = resolveCursorKey(chatJid, loopPendingTask?.status);
    const rawPendingMessages = getMessagesSinceSeq(
      chatJid,
      deps.getLastAgentTimestamps()[loopCursorKey] || '0',
      deps.assistantName,
    );
    const pendingMessages = filterLoopingPairedBotMessages(
      chatJid,
      getProcessableMessages(chatJid, rawPendingMessages, channel),
      FAILURE_FINAL_TEXT,
    );
    const messagesToSend =
      pendingMessages.length > 0 ? pendingMessages : processableGroupMessages;
    const labeledMessagesToSend = labelPairedSenders(chatJid, messagesToSend);
    const {
      formatted,
      botOnlyFollowUpAction,
      isBotOnlyPairedFollowUp,
      loopCursorKey: dispatchCursorKey,
      endSeq,
    } = buildQueuedTurnDispatch({
      chatJid,
      timezone: deps.timezone,
      loopPendingTask,
      rawPendingMessages,
      messagesToSend,
      labeledMessagesToSend,
      formatMessages,
    });

    if (
      await executeBotOnlyPairedFollowUpAction({
        action: botOnlyFollowUpAction,
        chatJid,
        group,
        runId: `loop-merge-ready-${Date.now().toString(36)}`,
        channel,
        log: logger,
        saveState: deps.saveState,
        lastAgentTimestamps: deps.getLastAgentTimestamps(),
        executeTurn,
        enqueueGroupMessageCheck: () =>
          enqueueScopedGroupMessageCheck(chatJid, group.folder),
        closeStdin: () =>
          deps.queue.closeStdin(chatJid, {
            reason: 'paired-pending-turn-follow-up',
          }),
      })
    ) {
      return;
    }

    if (deps.queue.sendMessage(chatJid, formatted)) {
      if (endSeq != null) {
        advanceLastAgentCursor(
          deps.getLastAgentTimestamps(),
          deps.saveState,
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
            logger.warn(
              { chatJid, err },
              'Failed to set typing indicator',
            ),
          );
      }
      return;
    }

    enqueueScopedGroupMessageCheck(chatJid, group.folder);
  };

  const processLoopGroupMessages = async (args: {
    chatJid: string;
    group: RegisteredGroup;
    groupMessages: NewMessage[];
    channel: Channel;
  }): Promise<void> => {
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
          deps.getLastAgentTimestamps(),
          deps.saveState,
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
          deps.getLastAgentTimestamps(),
          deps.saveState,
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
      (msg) => extractSessionCommand(msg.content, deps.triggerPattern) !== null,
    );

    if (loopCmdMsg) {
      if (
        isSessionCommandAllowed(
          isMainGroup,
          loopCmdMsg.is_from_me === true,
          isSessionCommandSenderAllowed(loopCmdMsg.sender),
        )
      ) {
        deps.queue.closeStdin(chatJid, {
          reason: 'session-command-detected',
        });
      }
      deps.queue.enqueueMessageCheck(chatJid);
      return;
    }

    if (
      !hasAllowedTrigger({
        chatJid,
        messages: processableGroupMessages,
        group,
        triggerPattern: deps.triggerPattern,
        hasImplicitContinuationWindow: continuationTracker.has,
      })
    ) {
      return;
    }

    await processQueuedGroupDispatch({
      chatJid,
      group,
      channel,
      processableGroupMessages,
    });
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
        enqueuePendingHandoffs();
        const registeredGroups = deps.getRegisteredGroups();
        const jids = Object.keys(registeredGroups);
        const { messages, newSeqCursor } = getNewMessagesBySeq(
          jids,
          deps.getLastTimestamp(),
          deps.assistantName,
        );

        if (messages.length > 0) {
          logger.info({ count: messages.length }, 'New messages');

          deps.setLastTimestamp(newSeqCursor);
          deps.saveState();

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

            const channel = findChannel(deps.channels, chatJid);
            if (!channel) {
              logger.warn(
                { chatJid },
                'No channel owns JID, skipping messages',
              );
              continue;
            }
            await processLoopGroupMessages({
              chatJid,
              group,
              groupMessages,
              channel,
            });
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in message loop');
      }
      await new Promise((resolve) => setTimeout(resolve, deps.pollInterval));
    }
  };

  const recoverPendingMessages = (): void => {
    const registeredGroups = deps.getRegisteredGroups();
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      const openWorkItem = getOpenWorkItemForChat(chatJid);
      if (openWorkItem) {
        logger.info(
          { chatJid, group: group.name, workItemId: openWorkItem.id },
          'Recovery: found open work item awaiting delivery',
        );
        enqueueScopedGroupMessageCheck(chatJid, group.folder);
        continue;
      }

      const sinceSeqCursor = deps.getLastAgentTimestamps()[chatJid] || '';
      const rawPending = getMessagesSinceSeq(
        chatJid,
        sinceSeqCursor,
        deps.assistantName,
      );
      const recoveryChannel = findChannel(deps.channels, chatJid);
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
        enqueueScopedGroupMessageCheck(chatJid, group.folder);
        continue;
      } else if (rawPending.length > 0) {
        const endSeq = rawPending[rawPending.length - 1].seq;
        if (endSeq != null) {
          advanceLastAgentCursor(
            deps.getLastAgentTimestamps(),
            deps.saveState,
            chatJid,
            endSeq,
          );
        }
      }
    }
  };

  return {
    processGroupMessages,
    recoverPendingMessages,
    startMessageLoop,
  };
}
