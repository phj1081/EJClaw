import { AgentOutput } from './agent-runner.js';
import {
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  getOpenWorkItem,
  createProducedWorkItem,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  type WorkItem,
} from './db.js';
import { isSessionCommandSenderAllowed } from './config.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import { findChannel, formatMessages } from './router.js';
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
  clearSession: (groupFolder: string) => void;
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

  const deliverOpenWorkItem = async (
    channel: Channel,
    item: WorkItem,
    options?: {
      replaceMessageId?: string | null;
    },
  ): Promise<boolean> => {
    const replaceMessageId = options?.replaceMessageId ?? null;
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
      const errorMessage = err instanceof Error ? err.message : String(err);
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
        onOutput,
      },
    );

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

    const openWorkItem = getOpenWorkItem(
      chatJid,
      (group.agentType || 'claude-code') as 'claude-code' | 'codex',
    );
    if (openWorkItem) {
      const delivered = await deliverOpenWorkItem(channel, openWorkItem);
      if (!delivered) return false;
    }

    const isMainGroup = group.isMain === true;
    const isClaudeCodeAgent =
      (group.agentType || 'claude-code') === 'claude-code';
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
          clearSession: () => deps.clearSession(group.folder),
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

      const output = await runAgent(group, prompt, chatJid, runId, (result) =>
        turnController.handleOutput(result),
      );

      const { deliverySucceeded, visiblePhase } =
        await turnController.finish(output);

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
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
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
