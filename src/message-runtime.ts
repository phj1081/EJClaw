import { AgentOutput } from './agent-runner.js';
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
  resolveActiveRole,
  resolveCursorKey,
  filterLoopingPairedBotMessages,
  getProcessableMessages,
  hasAllowedTrigger,
  shouldSkipBotOnlyCollaboration,
} from './message-runtime-rules.js';
import { buildArbiterContextPrompt } from './arbiter-context.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { MessageTurnController } from './message-turn-controller.js';
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
  type PairedTurnOutput,
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

  /** Convert paired turn outputs to NewMessage format for formatMessages(). */
  const turnOutputsToMessages = (
    outputs: PairedTurnOutput[],
    chatJid: string,
  ): NewMessage[] =>
    outputs.map((t) => ({
      id: `turn-${t.task_id}-${t.turn_number}`,
      chat_jid: chatJid,
      sender: t.role,
      sender_name: t.role,
      content: t.output_text,
      timestamp: t.created_at,
      is_bot_message: true as const,
      is_from_me: false as const,
    }));

  const mergeHumanAndTurnOutputMessages = (
    chatJid: string,
    humanMessages: NewMessage[],
    turnOutputs: PairedTurnOutput[],
  ): NewMessage[] =>
    [...humanMessages, ...turnOutputsToMessages(turnOutputs, chatJid)].sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp),
    );

  /**
   * Build a prompt from paired_turn_outputs (Discord-independent) + human messages.
   * Falls back to the legacy labelPairedSenders path when no turn outputs exist.
   */
  const buildPairedTurnPrompt = (
    taskId: string,
    chatJid: string,
    timezone: string,
    missedMessages: NewMessage[],
  ): string => {
    const turnOutputs = getPairedTurnOutputs(taskId);
    if (turnOutputs.length === 0) {
      // No stored outputs yet — fall back to Discord messages
      return formatMessages(
        labelPairedSenders(chatJid, missedMessages),
        timezone,
      );
    }

    // Human messages from the missed messages (exclude bot messages)
    const humanMessages = missedMessages.filter((m) => !m.is_bot_message);

    return formatMessages(
      mergeHumanAndTurnOutputMessages(chatJid, humanMessages, turnOutputs),
      timezone,
    );
  };

  const buildReviewerPendingPrompt = (
    task: PairedTask,
    chatJid: string,
    timezone: string,
  ): string => {
    const turnOutputs = getPairedTurnOutputs(task.id);
    if (turnOutputs.length > 0) {
      const humanMessages = getRecentChatMessages(chatJid, 20).filter(
        (message) => !message.is_bot_message,
      );
      return formatMessages(
        mergeHumanAndTurnOutputMessages(chatJid, humanMessages, turnOutputs),
        timezone,
      );
    }

    const userMessage = getLastHumanMessageContent(chatJid);
    if (!userMessage) {
      return 'Review the latest owner changes in the workspace.';
    }

    return `User request:\n---\n${userMessage}\n---\n\nReview the latest owner changes in the workspace.`;
  };

  const buildArbiterPromptForTask = (
    task: PairedTask,
    chatJid: string,
    timezone: string,
  ): string => {
    const turnOutputs = getPairedTurnOutputs(task.id);
    const recentMessages = getRecentChatMessages(chatJid, 20);
    const arbiterMessages =
      turnOutputs.length > 0
        ? mergeHumanAndTurnOutputMessages(
            chatJid,
            recentMessages.filter((message) => !message.is_bot_message),
            turnOutputs,
          )
        : labelPairedSenders(chatJid, recentMessages);

    return buildArbiterContextPrompt({
      chatJid,
      taskId: task.id,
      roundTripCount: task.round_trip_count,
      timezone,
      messages: arbiterMessages,
    });
  };

  const buildFinalizePendingPrompt = (task: PairedTask): string => {
    const turnOutputs = getPairedTurnOutputs(task.id);
    const lastReviewerOutput = [...turnOutputs]
      .reverse()
      .find((output) => output.role === 'reviewer');
    const reviewerSummary = lastReviewerOutput?.output_text
      ? `\n\nReviewer's final assessment:\n${lastReviewerOutput.output_text.slice(0, 2000)}`
      : '';

    return `The reviewer approved your work (DONE). Finalize and report the result.${reviewerSummary}`;
  };

  const isBotOnlyPairedRoomTurn = (
    chatJid: string,
    messages: NewMessage[],
  ): boolean =>
    hasReviewerLease(chatJid) &&
    messages.every(
      (message) => message.is_from_me === true || !!message.is_bot_message,
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
        (result) => turnController.handleOutput(result),
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

    const buildPendingPairedTurn = (
      task: PairedTask,
      rawMissedMessages: NewMessage[],
    ): {
      prompt: string;
      channel: Channel | null;
      cursor: string | number | null;
      cursorKey?: string;
      role?: 'reviewer' | 'arbiter';
    } | null => {
      const lastRaw = rawMissedMessages[rawMissedMessages.length - 1];
      const cursor = lastRaw?.seq ?? lastRaw?.timestamp ?? null;
      const taskStatus = task.status;
      const pendingRole = resolveActiveRole(taskStatus);

      if (pendingRole === 'reviewer') {
        return {
          prompt: buildReviewerPendingPrompt(task, chatJid, deps.timezone),
          channel: resolveChannel(taskStatus),
          cursor,
          cursorKey: resolveCursorKey(chatJid, taskStatus),
          role: 'reviewer',
        };
      }

      if (pendingRole === 'arbiter') {
        return {
          prompt: buildArbiterPromptForTask(task, chatJid, deps.timezone),
          channel: resolveChannel(taskStatus),
          cursor,
          cursorKey: resolveCursorKey(chatJid, taskStatus),
          role: 'arbiter',
        };
      }

      if (taskStatus === 'merge_ready') {
        return {
          prompt: buildFinalizePendingPrompt(task),
          channel: resolveChannel(taskStatus),
          cursor,
        };
      }

      return null;
    };

    const executePendingPairedTurn = async (args: {
      prompt: string;
      channel: Channel | null;
      cursor: string | number | null;
      cursorKey?: string;
      role?: 'reviewer' | 'arbiter';
    }): Promise<boolean> => {
      if (!args.channel) {
        const missingRole = args.role ?? 'reviewer';
        log.error(
          {
            role: missingRole,
            requiredChannel: getFixedRoleChannelName(missingRole),
          },
          'Skipping paired turn because the dedicated Discord role channel is not configured',
        );
        return false;
      }

      if (args.cursor != null) {
        advanceLastAgentCursor(
          deps.getLastAgentTimestamps(),
          deps.saveState,
          chatJid,
          args.cursor,
          args.cursorKey,
        );
      }

      const { deliverySucceeded } = await executeTurn({
        group,
        prompt: args.prompt,
        chatJid,
        runId,
        channel: args.channel,
        deliveryRole: args.role,
        startSeq: null,
        endSeq: null,
      });

      return deliverySucceeded;
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
      const skipQueuedFollowUpForInlineFinalize =
        hasReviewerLease(chatJid) &&
        deliveryRole === 'reviewer' &&
        pendingTask?.status === 'merge_ready';
      // Keep stale final delivery isolated from the next conversational turn.
      // A follow-up run will pick up any queued user messages or paired-room
      // auto-review/finalize transitions after this retry succeeds.
      //
      // merge_ready is special: the delivered reviewer bot message itself
      // triggers the inline finalize path. Queueing a generic follow-up here
      // can race with that path and produce a second owner finalize turn.
      if (skipQueuedFollowUpForInlineFinalize) {
        log.info(
          {
            workItemId: openWorkItem.id,
            chatJid,
            deliveryRole,
            pendingTaskStatus: pendingTask?.status ?? null,
          },
          'Skipping queued follow-up after reviewer merge_ready delivery because inline finalize will handle the handoff',
        );
      } else {
        deps.queue.enqueueMessageCheck(chatJid);
      }
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
          ? buildPendingPairedTurn(pendingReviewTask, rawMissedMessages)
          : null;
        if (pendingTurn) {
          return executePendingPairedTurn(pendingTurn);
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
          ? buildPendingPairedTurn(botOnlyPendingTask, rawMissedMessages)
          : null;
      if (botOnlyPendingTurn) {
        return executePendingPairedTurn(botOnlyPendingTurn);
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
                updatePairedTask(task.id, {
                  status: 'completed',
                  completion_reason: 'stopped',
                  updated_at: new Date().toISOString(),
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
        prompt = buildArbiterPromptForTask(
          pendingTaskForChannel,
          chatJid,
          deps.timezone,
        );
      } else if (pendingTaskForChannel) {
        prompt = buildPairedTurnPrompt(
          pendingTaskForChannel.id,
          chatJid,
          deps.timezone,
          missedMessages,
        );
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
              continue;
            }

            if (
              shouldSkipBotOnlyCollaboration(chatJid, processableGroupMessages)
            ) {
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
              continue;
            }

            const loopCmdMsg = groupMessages.find(
              (msg) =>
                extractSessionCommand(msg.content, deps.triggerPattern) !==
                null,
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
              continue;
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
              continue;
            }

            // Use role-aware cursor for paired rooms so the reviewer
            // always sees the owner's last messages and vice versa.
            const loopPendingTask = hasReviewerLease(chatJid)
              ? getLatestOpenPairedTaskForChat(chatJid)
              : null;
            const loopCursorKey = resolveCursorKey(
              chatJid,
              loopPendingTask?.status,
            );

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
              pendingMessages.length > 0
                ? pendingMessages
                : processableGroupMessages;
            const formatted = loopPendingTask
              ? buildPairedTurnPrompt(
                  loopPendingTask.id,
                  chatJid,
                  deps.timezone,
                  messagesToSend,
                )
              : formatMessages(
                  labelPairedSenders(chatJid, messagesToSend),
                  deps.timezone,
                );
            const isBotOnlyPairedFollowUp = isBotOnlyPairedRoomTurn(
              chatJid,
              messagesToSend,
            );
            const pendingCursorSource =
              rawPendingMessages.length > 0
                ? rawPendingMessages[rawPendingMessages.length - 1]
                : messagesToSend[messagesToSend.length - 1];
            if (
              loopPendingTask &&
              isBotOnlyPairedFollowUp &&
              loopPendingTask.status === 'merge_ready'
            ) {
              const inlineRunId = `loop-merge-ready-${Date.now().toString(36)}`;
              const mergeReadyCursor =
                pendingCursorSource?.seq ??
                pendingCursorSource?.timestamp ??
                null;
              if (mergeReadyCursor != null) {
                advanceLastAgentCursor(
                  deps.getLastAgentTimestamps(),
                  deps.saveState,
                  chatJid,
                  mergeReadyCursor,
                );
              }
              logger.info(
                {
                  chatJid,
                  group: group.name,
                  groupFolder: group.folder,
                  taskId: loopPendingTask?.id ?? null,
                  taskStatus: loopPendingTask?.status ?? null,
                  handoffMode: 'inline-finalize',
                  nextRole: 'owner',
                  cursor: mergeReadyCursor,
                },
                'Executing merge_ready finalize turn inline after bot-only reviewer follow-up',
              );
              const { deliverySucceeded } = await executeTurn({
                group,
                prompt: buildFinalizePendingPrompt(loopPendingTask),
                chatJid,
                runId: inlineRunId,
                channel,
                startSeq: null,
                endSeq: null,
              });
              if (!deliverySucceeded) {
                deps.queue.enqueueMessageCheck(
                  chatJid,
                  resolveGroupIpcPath(group.folder),
                );
              }
              continue;
            }
            const botOnlyPendingTurn =
              loopPendingTask &&
              isBotOnlyPairedFollowUp &&
              (loopPendingTask.status === 'review_ready' ||
                loopPendingTask.status === 'in_review' ||
                loopPendingTask.status === 'arbiter_requested' ||
                loopPendingTask.status === 'in_arbitration')
                ? {
                    cursor:
                      pendingCursorSource?.seq ??
                      pendingCursorSource?.timestamp ??
                      null,
                    cursorKey: resolveCursorKey(
                      chatJid,
                      loopPendingTask.status,
                    ),
                  }
                : null;

            if (botOnlyPendingTurn) {
              if (botOnlyPendingTurn.cursor != null) {
                advanceLastAgentCursor(
                  deps.getLastAgentTimestamps(),
                  deps.saveState,
                  chatJid,
                  botOnlyPendingTurn.cursor,
                  botOnlyPendingTurn.cursorKey,
                );
              }
              deps.queue.closeStdin(chatJid, {
                reason: 'paired-pending-turn-follow-up',
              });
              deps.queue.enqueueMessageCheck(
                chatJid,
                resolveGroupIpcPath(group.folder),
              );
              logger.info(
                {
                  chatJid,
                  group: group.name,
                  groupFolder: group.folder,
                  taskId: loopPendingTask?.id ?? null,
                  taskStatus: loopPendingTask?.status ?? null,
                  handoffMode: 'requeue',
                  nextRole:
                    loopPendingTask?.status === 'review_ready'
                      ? 'reviewer'
                      : loopPendingTask?.status === 'arbiter_requested' ||
                          loopPendingTask?.status === 'in_arbitration'
                        ? 'arbiter'
                        : 'reviewer',
                  cursor: botOnlyPendingTurn.cursor,
                  cursorKey: botOnlyPendingTurn.cursorKey,
                },
                'Queued fresh paired pending turn instead of piping bot-only follow-up into the active agent',
              );
              continue;
            }

            if (deps.queue.sendMessage(chatJid, formatted)) {
              const endSeq = messagesToSend[messagesToSend.length - 1]?.seq;
              if (endSeq != null) {
                advanceLastAgentCursor(
                  deps.getLastAgentTimestamps(),
                  deps.saveState,
                  chatJid,
                  endSeq,
                  loopCursorKey,
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
              continue;
            }

            deps.queue.enqueueMessageCheck(
              chatJid,
              resolveGroupIpcPath(group.folder),
            );
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
        deps.queue.enqueueMessageCheck(
          chatJid,
          resolveGroupIpcPath(group.folder),
        );
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
        deps.queue.enqueueMessageCheck(
          chatJid,
          resolveGroupIpcPath(group.folder),
        );
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
