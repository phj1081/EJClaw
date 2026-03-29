import { AgentOutput } from './agent-runner.js';
import { getErrorMessage } from './utils.js';
import {
  claimServiceHandoff,
  completeServiceHandoffAndAdvanceTargetCursor,
  createProducedWorkItem,
  failServiceHandoff,
  getOpenWorkItem,
  getPendingServiceHandoffs,
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  getLastBotFinalMessage,
  getLastHumanMessageContent,
  isPairedRoomJid,
  getLatestOpenPairedTaskForChat,
  updatePairedTask,
  type ServiceHandoff,
  type WorkItem,
} from './db.js';
import {
  isSessionCommandSenderAllowed,
  REVIEWER_AGENT_TYPE,
  SERVICE_AGENT_TYPE,
  SERVICE_ID,
} from './config.js';
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
  filterLoopingPairedBotMessages,
  getProcessableMessages,
  hasAllowedTrigger,
  shouldSkipBotOnlyCollaboration,
} from './message-runtime-rules.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { MessageTurnController } from './message-turn-controller.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
  isSessionCommandControlMessage,
} from './session-commands.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { getEffectiveChannelLease } from './service-routing.js';

/**
 * Check if a message is a duplicate of the last bot final message in a paired room.
 * Exported for testing purposes.
 */
export function isDuplicateOfLastBotFinal(
  chatJid: string,
  text: string,
): boolean {
  // Only check in paired rooms (both claude and codex registered)
  if (!isPairedRoomJid(chatJid)) {
    return false;
  }

  // Get the last bot final message from DB (any bot, not just this service)
  const lastMessages = getLastBotFinalMessage(chatJid, SERVICE_AGENT_TYPE, 1);
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
  const isBotOnlyPairedRoomTurn = (
    chatJid: string,
    messages: NewMessage[],
  ): boolean =>
    isPairedRoomJid(chatJid) &&
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
        {
          chatJid: item.chat_jid,
          workItemId: item.id,
          preview: item.result_payload.slice(0, 100),
        },
        'Suppressed duplicate final message in paired room (marked as delivered)',
      );
      return true;
    }

    try {
      if (replaceMessageId && channel.editMessage) {
        await channel.editMessage(
          item.chat_jid,
          replaceMessageId,
          item.result_payload,
        );
        markWorkItemDelivered(item.id, replaceMessageId);
        continuationTracker.open(item.chat_jid);
        logger.info(
          {
            chatJid: item.chat_jid,
            workItemId: item.id,
            deliveryAttempts: item.delivery_attempts + 1,
            replacedMessageId: replaceMessageId,
          },
          'Delivered produced work item by replacing tracked progress message',
        );
        return true;
      }
    } catch (err) {
      logger.warn(
        {
          chatJid: item.chat_jid,
          workItemId: item.id,
          deliveryAttempts: item.delivery_attempts + 1,
          replacedMessageId: replaceMessageId,
          err,
        },
        'Failed to replace tracked progress message; falling back to a new message',
      );
    }

    try {
      await channel.sendMessage(item.chat_jid, item.result_payload);
      markWorkItemDelivered(item.id);
      continuationTracker.open(item.chat_jid);
      logger.info(
        {
          chatJid: item.chat_jid,
          workItemId: item.id,
          deliveryAttempts: item.delivery_attempts + 1,
        },
        'Delivered produced work item',
      );
      return true;
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      markWorkItemDeliveryRetry(item.id, errorMessage);
      logger.warn(
        {
          chatJid: item.chat_jid,
          workItemId: item.id,
          deliveryAttempts: item.delivery_attempts + 1,
          err,
        },
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
      (group.agentType || 'claude-code') === 'claude-code';

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
          const workItem = createProducedWorkItem({
            group_folder: group.folder,
            chat_jid: chatJid,
            agent_type: group.agentType || 'claude-code',
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
        { startSeq, endSeq },
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
    for (const handoff of getPendingServiceHandoffs(SERVICE_ID)) {
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

    const runId = `handoff-${handoff.id}`;
    try {
      const result = await executeTurn({
        group,
        prompt: handoff.prompt,
        chatJid: handoff.chat_jid,
        runId,
        channel,
        startSeq: handoff.start_seq,
        endSeq: handoff.end_seq,
      });

      if (!result.deliverySucceeded) {
        failServiceHandoff(handoff.id, 'Handoff delivery failed');
        return;
      }

      const appliedCursor = completeServiceHandoffAndAdvanceTargetCursor({
        id: handoff.id,
        target_service_id: handoff.target_service_id,
        chat_jid: handoff.chat_jid,
        end_seq: handoff.end_seq,
      });
      if (appliedCursor) {
        deps.getLastAgentTimestamps()[handoff.chat_jid] = appliedCursor;
      }
      logger.info(
        {
          chatJid: handoff.chat_jid,
          handoffId: handoff.id,
          runId,
          outputStatus: result.outputStatus,
          visiblePhase: result.visiblePhase,
          appliedCursor,
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

    const channel = findChannel(deps.channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    // For paired rooms, determine the reviewer channel for correct bot routing.
    // This is used whenever the reviewer needs to send output.
    const reviewerChannelName =
      isPairedRoomJid(chatJid) && REVIEWER_AGENT_TYPE === 'claude-code'
        ? 'discord'
        : 'discord-review';
    const foundReviewerChannel = findChannelByName(
      deps.channels,
      reviewerChannelName,
    );
    const reviewerChannel = foundReviewerChannel || channel;
    if (isPairedRoomJid(chatJid)) {
      logger.info(
        {
          chatJid,
          reviewerChannelName,
          foundChannel: foundReviewerChannel?.name ?? null,
          usingChannel: reviewerChannel.name,
          availableChannels: deps.channels.map((c) => c.name),
        },
        'Paired room reviewer channel resolution',
      );
    }

    // Deliver pending work items through the correct channel.
    // For paired rooms, check if the work item was from a reviewer turn.
    const openWorkItem = getOpenWorkItem(
      chatJid,
      (group.agentType || 'claude-code') as 'claude-code' | 'codex',
    );
    if (openWorkItem) {
      // Use reviewer channel if the pending task is in review state
      const pendingTask = isPairedRoomJid(chatJid)
        ? getLatestOpenPairedTaskForChat(chatJid)
        : null;
      const isReviewerWorkItem =
        pendingTask &&
        (pendingTask.status === 'review_ready' ||
          pendingTask.status === 'in_review');
      const deliveryChannel = isReviewerWorkItem ? reviewerChannel : channel;
      const delivered = await deliverOpenWorkItem(
        deliveryChannel,
        openWorkItem,
      );
      if (!delivered) return false;
      // Keep stale final delivery isolated from the next conversational turn.
      // A follow-up run will pick up any queued user messages or paired-room
      // auto-review/finalize transitions after this retry succeeds.
      deps.queue.enqueueMessageCheck(chatJid);
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
        const pendingReviewTask = isPairedRoomJid(chatJid)
          ? getLatestOpenPairedTaskForChat(chatJid)
          : null;
        if (
          pendingReviewTask &&
          (pendingReviewTask.status === 'review_ready' ||
            pendingReviewTask.status === 'in_review')
        ) {
          // No processable messages remain. Review workspace state using the
          // user's request as context, but don't re-inject filtered raw bot
          // output from older turns into the next review prompt.
          const userMessage = getLastHumanMessageContent(chatJid);
          const parts: string[] = [];
          if (userMessage) {
            parts.push(`User request:\n---\n${userMessage}\n---`);
          }
          const reviewPrompt =
            parts.length > 0
              ? `${parts.join('\n\n')}\n\nReview the latest owner changes in the workspace.`
              : 'Review the latest owner changes in the workspace.';

          // Advance cursor past filtered bot messages so they aren't re-processed
          const lastRaw = rawMissedMessages[rawMissedMessages.length - 1];
          const cursor = lastRaw?.seq ?? lastRaw?.timestamp;
          if (cursor != null) {
            advanceLastAgentCursor(
              deps.getLastAgentTimestamps(),
              deps.saveState,
              chatJid,
              cursor,
            );
          }

          const { deliverySucceeded } = await executeTurn({
            group,
            prompt: reviewPrompt,
            chatJid,
            runId,
            channel: reviewerChannel,
            startSeq: null,
            endSeq: null,
          });
          return deliverySucceeded;
        }

        // merge_ready: reviewer approved, owner gets final turn to finalize
        if (pendingReviewTask && pendingReviewTask.status === 'merge_ready') {
          const lastRaw = rawMissedMessages[rawMissedMessages.length - 1];
          const cursor = lastRaw?.seq ?? lastRaw?.timestamp;
          if (cursor != null) {
            advanceLastAgentCursor(
              deps.getLastAgentTimestamps(),
              deps.saveState,
              chatJid,
              cursor,
            );
          }
          const finalizePrompt =
            'The reviewer approved your work (DONE). Finalize and report the result.';
          const { deliverySucceeded } = await executeTurn({
            group,
            prompt: finalizePrompt,
            chatJid,
            runId,
            channel,
            startSeq: null,
            endSeq: null,
          });
          return deliverySucceeded;
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
        logger.info(
          { chatJid, group: group.name, groupFolder: group.folder, runId },
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
            if (isPairedRoomJid(chatJid)) {
              const task = getLatestOpenPairedTaskForChat(chatJid);
              if (task) {
                updatePairedTask(task.id, {
                  status: 'completed',
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
        logger.info(
          { chatJid, group: group.name, groupFolder: group.folder, runId },
          'Skipping queued run because no allowed trigger was found',
        );
        return true;
      }

      const prompt = formatMessages(missedMessages, deps.timezone);
      const startSeq = missedMessages[0].seq ?? null;
      const endSeq = missedMessages[missedMessages.length - 1].seq ?? null;
      if (endSeq !== null) {
        advanceLastAgentCursor(
          deps.getLastAgentTimestamps(),
          deps.saveState,
          chatJid,
          endSeq,
        );
      }

      logger.info(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          messageCount: missedMessages.length,
        },
        'Dispatching queued messages to agent',
      );
      // Use reviewer channel when the agent will run in reviewer mode.
      // This is determined by the paired task status — if review_ready
      // or in_review, the executor switches to reviewer mode.
      const pendingTaskForChannel = isPairedRoomJid(chatJid)
        ? getLatestOpenPairedTaskForChat(chatJid)
        : null;
      const useReviewerChannel =
        pendingTaskForChannel &&
        (pendingTaskForChannel.status === 'review_ready' ||
          pendingTaskForChannel.status === 'in_review');
      const turnChannel = useReviewerChannel ? reviewerChannel : channel;

      const { deliverySucceeded, visiblePhase } = await executeTurn({
        group,
        prompt,
        chatJid,
        runId,
        channel: turnChannel,
        startSeq,
        endSeq,
      });

      if (!deliverySucceeded) {
        logger.warn(
          { chatJid, group: group.name, groupFolder: group.folder, runId },
          'Persisted produced output for delivery retry without rerunning agent',
        );
        return false;
      }

      logger.info(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          visiblePhase,
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

            const rawPendingMessages = getMessagesSinceSeq(
              chatJid,
              deps.getLastAgentTimestamps()[chatJid] || '0',
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
            const formatted = formatMessages(messagesToSend, deps.timezone);
            const isBotOnlyPairedFollowUp = isBotOnlyPairedRoomTurn(
              chatJid,
              messagesToSend,
            );

            if (deps.queue.sendMessage(chatJid, formatted)) {
              const endSeq = messagesToSend[messagesToSend.length - 1]?.seq;
              if (endSeq != null) {
                advanceLastAgentCursor(
                  deps.getLastAgentTimestamps(),
                  deps.saveState,
                  chatJid,
                  endSeq,
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
      const openWorkItem = getOpenWorkItem(
        chatJid,
        (group.agentType || 'claude-code') as 'claude-code' | 'codex',
      );
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
