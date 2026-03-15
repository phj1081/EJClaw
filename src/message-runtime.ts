import {
  AgentOutput,
  AvailableGroup,
  runAgentProcess,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner.js';
import {
  getAllChats,
  getAllTasks,
  getLastHumanMessageTimestamp,
  getMessagesSince,
  getNewMessages,
} from './db.js';
import { isSessionCommandSenderAllowed } from './config.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import { findChannel, formatMessages } from './router.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

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

export function getAvailableGroups(
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((chat) => chat.jid !== '__group_sync__' && chat.is_group)
    .map((chat) => ({
      jid: chat.jid,
      name: chat.name,
      lastActivity: chat.last_message_time,
      isRegistered: registeredJids.has(chat.jid),
    }));
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

  const getCurrentAvailableGroups = (): AvailableGroup[] =>
    getAvailableGroups(deps.getRegisteredGroups());

  const runAgent = async (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    runId: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ): Promise<'success' | 'error'> => {
    const isMain = group.isMain === true;
    const sessions = deps.getSessions();
    const sessionId = sessions[group.folder];

    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((task) => ({
        id: task.id,
        groupFolder: task.group_folder,
        prompt: task.prompt,
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
        status: task.status,
        next_run: task.next_run,
      })),
    );

    writeGroupsSnapshot(group.folder, isMain, getCurrentAvailableGroups());

    const wrappedOnOutput = onOutput
      ? async (output: AgentOutput) => {
          if (output.newSessionId) {
            deps.persistSession(group.folder, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await runAgentProcess(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          runId,
          isMain,
          assistantName: deps.assistantName,
        },
        (proc, processName) =>
          deps.queue.registerProcess(chatJid, proc, processName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId) {
        deps.persistSession(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error(
          { group: group.name, chatJid, runId, error: output.error },
          'Agent process error',
        );
        return 'error';
      }

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, chatJid, runId, err }, 'Agent error');
      return 'error';
    }
  };

  const processGroupMessages = async (
    chatJid: string,
    context: GroupRunContext,
  ): Promise<boolean> => {
    const { runId, reason } = context;
    const registeredGroups = deps.getRegisteredGroups();
    const group = registeredGroups[chatJid];
    if (!group) {
      logger.warn(
        { chatJid, runId, reason },
        'Registered group missing for queued run',
      );
      return true;
    }

    const channel = findChannel(deps.channels, chatJid);
    if (!channel) {
      logger.warn(
        { chatJid, runId, reason },
        'No channel owns JID, skipping messages',
      );
      return true;
    }

    const isMainGroup = group.isMain === true;
    const lastAgentTimestamps = deps.getLastAgentTimestamps();
    const sinceTimestamp = lastAgentTimestamps[chatJid] || '';
    const missedMessages = getMessagesSince(
      chatJid,
      sinceTimestamp,
      deps.assistantName,
    );

    if (missedMessages.length === 0) {
      logger.info(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          reason,
        },
        'No pending messages for queued run',
      );
      return true;
    }

    logger.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        reason,
        messageCount: missedMessages.length,
        sinceTimestamp,
      },
      'Loaded pending messages for queued run',
    );

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
            runId,
            reason: 'session-command',
          }),
        clearSession: () => deps.clearSession(group.folder),
        advanceCursor: (timestamp) => {
          lastAgentTimestamps[chatJid] = timestamp;
          deps.saveState();
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

    if (!isMainGroup && group.requiresTrigger !== false) {
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (msg) =>
          deps.triggerPattern.test(msg.content.trim()) &&
          (msg.is_from_me ||
            isTriggerAllowed(chatJid, msg.sender, allowlistCfg)),
      );
      if (!hasTrigger) {
        logger.info(
          { chatJid, group: group.name, groupFolder: group.folder, runId },
          'Skipping queued run because no allowed trigger was found',
        );
        return true;
      }
    }

    const prompt = formatMessages(missedMessages, deps.timezone);
    const previousCursor = lastAgentTimestamps[chatJid] || '';
    lastAgentTimestamps[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    deps.saveState();

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

    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.info(
          { chatJid, group: group.name, groupFolder: group.folder, runId },
          'Idle timeout reached, closing active agent stdin',
        );
        deps.queue.closeStdin(chatJid, {
          runId,
          reason: 'idle-timeout',
        });
      }, deps.idleTimeout);
    };

    let hadError = false;
    let outputSentToUser = false;

    await channel.setTyping?.(chatJid, true);

    const output = await runAgent(
      group,
      prompt,
      chatJid,
      runId,
      async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            {
              chatJid,
              group: group.name,
              groupFolder: group.folder,
              runId,
              resultStatus: result.status,
            },
            `Agent output: ${raw.slice(0, 200)}`,
          );
          if (text) {
            await channel.sendMessage(chatJid, text);
            outputSentToUser = true;
          }
        }

        await channel.setTyping?.(chatJid, false);
        resetIdleTimer();

        if (result.status === 'success') {
          deps.queue.notifyIdle(chatJid, runId);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );

    await channel.setTyping?.(chatJid, false);

    if (output === 'error') {
      hadError = true;
    }

    if (idleTimer) clearTimeout(idleTimer);

    if (hadError) {
      if (outputSentToUser) {
        logger.warn(
          { chatJid, group: group.name, groupFolder: group.folder, runId },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      lastAgentTimestamps[chatJid] = previousCursor;
      deps.saveState();
      logger.warn(
        { chatJid, group: group.name, groupFolder: group.folder, runId },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    logger.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        outputSentToUser,
      },
      'Queued run completed successfully',
    );

    return true;
  };

  const startMessageLoop = async (): Promise<void> => {
    if (messageLoopRunning) {
      logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    messageLoopRunning = true;

    logger.info(`NanoClaw running (trigger: @${deps.assistantName})`);

    while (true) {
      try {
        const registeredGroups = deps.getRegisteredGroups();
        const jids = Object.keys(registeredGroups);
        const { messages, newTimestamp } = getNewMessages(
          jids,
          deps.getLastTimestamp(),
          deps.assistantName,
        );

        if (messages.length > 0) {
          logger.info({ count: messages.length }, 'New messages');

          deps.setLastTimestamp(newTimestamp);
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
            const allFromBots = groupMessages.every(
              (msg) => msg.is_from_me || !!msg.is_bot_message,
            );
            if (allFromBots) {
              const lastHuman = getLastHumanMessageTimestamp(chatJid);
              if (
                !lastHuman ||
                Date.now() - new Date(lastHuman).getTime() > 12 * 60 * 60 * 1000
              ) {
                logger.info(
                  { chatJid, lastHuman },
                  'Bot-collaboration timeout: no human message within 12h, skipping',
                );
                continue;
              }
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

            const needsTrigger =
              !isMainGroup && group.requiresTrigger !== false;
            if (needsTrigger) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (msg) =>
                  deps.triggerPattern.test(msg.content.trim()) &&
                  (msg.is_from_me ||
                    isTriggerAllowed(chatJid, msg.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }

            const lastAgentTimestamps = deps.getLastAgentTimestamps();
            const allPending = getMessagesSince(
              chatJid,
              lastAgentTimestamps[chatJid] || '',
              deps.assistantName,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(messagesToSend, deps.timezone);

            if (deps.queue.sendMessage(chatJid, formatted)) {
              logger.debug(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active agent',
              );
              lastAgentTimestamps[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              deps.saveState();
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
            } else {
              deps.queue.enqueueMessageCheck(chatJid, group.folder);
            }
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
    const lastAgentTimestamps = deps.getLastAgentTimestamps();
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      const sinceTimestamp = lastAgentTimestamps[chatJid] || '';
      const pending = getMessagesSince(
        chatJid,
        sinceTimestamp,
        deps.assistantName,
      );
      if (pending.length > 0) {
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        deps.queue.enqueueMessageCheck(chatJid, group.folder);
      }
    }
  };

  return {
    processGroupMessages,
    recoverPendingMessages,
    startMessageLoop,
  };
}
