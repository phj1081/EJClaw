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
  getLatestMessageSeqAtOrBefore,
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  getOpenWorkItem,
  createProducedWorkItem,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  isPairedRoomJid,
  type WorkItem,
} from './db.js';
import { DATA_DIR, isSessionCommandSenderAllowed } from './config.js';
import { GroupQueue, GroupRunContext } from './group-queue.js';
import { filterProcessableMessages } from './bot-message-filter.js';
import {
  detectFallbackTrigger,
  getActiveProvider,
  getFallbackEnvOverrides,
  getFallbackProviderName,
  hasGroupProviderOverride,
  isFallbackEnabled,
  markPrimaryCooldown,
} from './provider-fallback.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
  isSessionCommandControlMessage,
} from './session-commands.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import path from 'path';

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

  const normalizeStoredSeqCursor = (
    cursor: string | undefined,
    chatJid?: string,
  ): string => {
    if (!cursor) return '0';
    if (/^\d+$/.test(cursor.trim())) return cursor.trim();
    return String(getLatestMessageSeqAtOrBefore(cursor, chatJid));
  };

  const advanceLastAgentCursor = (
    chatJid: string,
    cursorOrTimestamp: string | number,
  ): void => {
    const lastAgentTimestamps = deps.getLastAgentTimestamps();
    if (typeof cursorOrTimestamp === 'number') {
      lastAgentTimestamps[chatJid] = String(cursorOrTimestamp);
    } else {
      lastAgentTimestamps[chatJid] = normalizeStoredSeqCursor(
        cursorOrTimestamp,
        chatJid,
      );
    }
    deps.saveState();
  };

  const getProcessableMessages = (
    chatJid: string,
    messages: Parameters<typeof filterProcessableMessages>[0],
    channel?: Channel,
  ) =>
    filterProcessableMessages(
      messages,
      isPairedRoomJid(chatJid),
      channel?.isOwnMessage?.bind(channel),
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
  ): Promise<'success' | 'error'> => {
    const isMain = group.isMain === true;
    const isClaudeCodeAgent =
      (group.agentType || 'claude-code') === 'claude-code';
    const sessions = deps.getSessions();
    const sessionId = sessions[group.folder];

    const tasks = getAllTasks(group.agentType || 'claude-code');
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

    let resetSessionRequested = false;

    const settingsPath = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'settings.json',
    );
    const groupHasOverride = hasGroupProviderOverride(settingsPath);
    const canFallback =
      isClaudeCodeAgent && isFallbackEnabled() && !groupHasOverride;

    const agentInput = {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      runId,
      isMain,
      assistantName: deps.assistantName,
    };

    const runAttempt = async (
      provider: string,
    ): Promise<{
      output?: AgentOutput;
      error?: unknown;
      sawOutput: boolean;
      sawSuccessNullResultWithoutOutput: boolean;
      streamedTriggerReason?: {
        reason: string;
        retryAfterMs?: number;
      };
    }> => {
      const persistSessionIds = provider === 'claude';
      let sawOutput = false;
      let sawSuccessNullResultWithoutOutput = false;
      let streamedTriggerReason:
        | {
            reason: string;
            retryAfterMs?: number;
          }
        | undefined;

      const wrappedOnOutput = onOutput
        ? async (output: AgentOutput) => {
            if (persistSessionIds && output.newSessionId) {
              deps.persistSession(group.folder, output.newSessionId);
            }
            if (
              persistSessionIds &&
              isClaudeCodeAgent &&
              shouldResetSessionOnAgentFailure(output)
            ) {
              resetSessionRequested = true;
            }
            if (output.result !== null && output.result !== undefined) {
              sawOutput = true;
            } else if (
              provider === 'claude' &&
              output.status === 'success' &&
              !sawOutput
            ) {
              sawSuccessNullResultWithoutOutput = true;
            }
            if (
              provider === 'claude' &&
              output.status === 'error' &&
              !sawOutput &&
              !streamedTriggerReason
            ) {
              const trigger = detectFallbackTrigger(output.error);
              if (trigger.shouldFallback) {
                streamedTriggerReason = {
                  reason: trigger.reason,
                  retryAfterMs: trigger.retryAfterMs,
                };
              }
            }
            await onOutput(output);
          }
        : undefined;

      if (provider !== 'claude') {
        logger.info(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            provider,
          },
          `Claude provider in cooldown, routing request to ${provider}`,
        );
      }

      logger.info(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          provider,
          canFallback,
          groupHasOverride,
        },
        `Using provider: ${provider}`,
      );

      try {
        const output = await runAgentProcess(
          group,
          {
            ...agentInput,
            sessionId: persistSessionIds ? sessionId : undefined,
          },
          (proc, processName) =>
            deps.queue.registerProcess(
              chatJid,
              proc,
              processName,
              group.folder,
            ),
          wrappedOnOutput,
          provider === 'claude' ? undefined : getFallbackEnvOverrides(),
        );

        if (persistSessionIds && output.newSessionId) {
          deps.persistSession(group.folder, output.newSessionId);
        }

        logger.info(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            provider,
            status: output.status,
            sawOutput,
          },
          `Provider response completed (provider: ${provider})`,
        );

        return {
          output,
          sawOutput,
          sawSuccessNullResultWithoutOutput,
          streamedTriggerReason,
        };
      } catch (error) {
        return {
          error,
          sawOutput,
          sawSuccessNullResultWithoutOutput,
          streamedTriggerReason,
        };
      }
    };

    const runFallbackAttempt = async (
      reason: string,
      retryAfterMs?: number,
    ): Promise<'success' | 'error'> => {
      const fallbackName = getFallbackProviderName();
      markPrimaryCooldown(reason, retryAfterMs);

      logger.info(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          reason,
          retryAfterMs,
          fallbackProvider: fallbackName,
        },
        `Falling back to provider: ${fallbackName} (reason: ${reason})`,
      );

      const fallbackAttempt = await runAttempt(fallbackName);
      if (fallbackAttempt.error) {
        logger.error(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            provider: fallbackName,
            err: fallbackAttempt.error,
          },
          'Fallback provider also threw',
        );
        return 'error';
      }

      if (fallbackAttempt.output?.status === 'error') {
        logger.error(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            provider: fallbackName,
            error: fallbackAttempt.output.error,
          },
          `Fallback provider (${fallbackName}) also failed`,
        );
        return 'error';
      }

      return 'success';
    };

    const provider = canFallback ? getActiveProvider() : 'claude';
    const primaryAttempt = await runAttempt(provider);

    if (primaryAttempt.error) {
      if (canFallback && provider === 'claude' && !primaryAttempt.sawOutput) {
        const errMsg =
          primaryAttempt.error instanceof Error
            ? primaryAttempt.error.message
            : String(primaryAttempt.error);
        const trigger = primaryAttempt.streamedTriggerReason
          ? {
              shouldFallback: true,
              reason: primaryAttempt.streamedTriggerReason.reason,
              retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
            }
          : detectFallbackTrigger(errMsg);
        if (trigger.shouldFallback) {
          return runFallbackAttempt(trigger.reason, trigger.retryAfterMs);
        }
      }

      logger.error(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          provider,
          err: primaryAttempt.error,
        },
        'Agent error',
      );
      return 'error';
    }

    const output = primaryAttempt.output;
    if (!output) {
      logger.error(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          provider,
        },
        'Agent produced no output object',
      );
      return 'error';
    }

    if (
      canFallback &&
      provider === 'claude' &&
      !primaryAttempt.sawOutput &&
      primaryAttempt.sawSuccessNullResultWithoutOutput
    ) {
      return runFallbackAttempt('success-null-result');
    }

    if (
      isClaudeCodeAgent &&
      (resetSessionRequested || shouldResetSessionOnAgentFailure(output))
    ) {
      deps.clearSession(group.folder);
      logger.warn(
        { group: group.name, chatJid, runId },
        'Cleared poisoned agent session after unrecoverable error',
      );
    }

    if (output.status === 'error') {
      if (canFallback && provider === 'claude' && !primaryAttempt.sawOutput) {
        const trigger = primaryAttempt.streamedTriggerReason
          ? {
              shouldFallback: true,
              reason: primaryAttempt.streamedTriggerReason.reason,
              retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
            }
          : detectFallbackTrigger(output.error);
        if (trigger.shouldFallback) {
          return runFallbackAttempt(trigger.reason, trigger.retryAfterMs);
        }
      }

      logger.error(
        {
          group: group.name,
          chatJid,
          runId,
          provider,
          error: output.error,
        },
        'Agent process error',
      );
      return 'error';
    }

    return 'success';
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
    const FAILURE_FINAL_TEXT =
      '요청을 완료하지 못했습니다. 다시 시도해 주세요.';

    while (true) {
      const sinceSeqCursor = deps.getLastAgentTimestamps()[chatJid] || '0';
      const rawMissedMessages = getMessagesSinceSeq(
        chatJid,
        sinceSeqCursor,
        deps.assistantName,
      );
      const missedMessages = getProcessableMessages(
        chatJid,
        rawMissedMessages,
        channel,
      );

      if (missedMessages.length === 0) {
        const lastIgnored = rawMissedMessages[rawMissedMessages.length - 1];
        if (lastIgnored) {
          advanceLastAgentCursor(chatJid, lastIgnored.timestamp);
        }
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
            advanceLastAgentCursor(chatJid, cursorOrTimestamp);
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
      const startSeq = missedMessages[0].seq ?? null;
      const endSeq = missedMessages[missedMessages.length - 1].seq ?? null;
      if (endSeq !== null) {
        advanceLastAgentCursor(chatJid, endSeq);
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

      type VisiblePhase = 'silent' | 'progress' | 'final';
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let hadError = false;
      let producedDeliverySucceeded = true;
      let visiblePhase: VisiblePhase = 'silent';
      let latestProgressText: string | null = null;
      let latestProgressRendered: string | null = null;
      let progressMessageId: string | null = null;
      let progressStartedAt: number | null = null;
      let progressTicker: ReturnType<typeof setInterval> | null = null;
      let progressEditFailCount = 0;
      let latestProgressTextForFinal: string | null = null;
      let poisonedSessionDetected = false;
      let closeRequested = false;

      const hasVisibleOutput = () => visiblePhase !== 'silent';
      const terminalObserved = () => visiblePhase === 'final';

      const clearProgressTicker = () => {
        if (progressTicker) {
          clearInterval(progressTicker);
          progressTicker = null;
        }
      };

      const resetProgressState = () => {
        clearProgressTicker();
        latestProgressText = null;
        latestProgressRendered = null;
        progressMessageId = null;
        progressStartedAt = null;
        progressEditFailCount = 0;
      };

      const renderProgressMessage = (text: string) => {
        const elapsedSeconds =
          progressStartedAt === null
            ? 0
            : Math.floor((Date.now() - progressStartedAt) / 10_000) * 10;
        const hours = Math.floor(elapsedSeconds / 3600);
        const minutes = Math.floor((elapsedSeconds % 3600) / 60);
        const seconds = elapsedSeconds % 60;
        const elapsedParts: string[] = [];

        if (hours > 0) elapsedParts.push(`${hours}시간`);
        if (minutes > 0) elapsedParts.push(`${minutes}분`);
        elapsedParts.push(`${seconds}초`);

        return `${text}\n\n${elapsedParts.join(' ')}`;
      };

      const syncTrackedProgressMessage = async () => {
        if (!progressMessageId || !channel.editMessage || !latestProgressText) {
          return;
        }

        const rendered = renderProgressMessage(latestProgressText);
        if (rendered === latestProgressRendered) {
          return;
        }

        try {
          await channel.editMessage(chatJid, progressMessageId, rendered);
          latestProgressRendered = rendered;
          progressEditFailCount = 0;
        } catch (err) {
          progressEditFailCount++;
          logger.warn(
            {
              chatJid,
              group: group.name,
              groupFolder: group.folder,
              runId,
              progressMessageId,
              progressEditFailCount,
              err,
            },
            'Failed to edit tracked progress message; will retry before recreating',
          );
          latestProgressRendered = null;
          if (progressEditFailCount >= 3) {
            clearProgressTicker();
          }
        }
      };

      const ensureProgressTicker = () => {
        if (!progressMessageId || !channel.editMessage || progressTicker) {
          return;
        }

        progressTicker = setInterval(() => {
          void syncTrackedProgressMessage();
        }, 10_000);
      };

      const finalizeProgressMessage = async (options?: {
        preserveTrackedMessage?: boolean;
      }): Promise<string | null> => {
        logger.info(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            progressMessageId,
            latestProgressText,
          },
          'Finalizing tracked progress message',
        );
        const trackedMessageId = progressMessageId;
        if (!options?.preserveTrackedMessage) {
          await syncTrackedProgressMessage();
        }
        resetProgressState();
        return trackedMessageId;
      };

      const deliverFinalText = async (
        text: string,
        replaceMessageId?: string | null,
      ) => {
        visiblePhase = 'final';
        try {
          const workItem = createProducedWorkItem({
            group_folder: group.folder,
            chat_jid: chatJid,
            agent_type: group.agentType || 'claude-code',
            start_seq: startSeq,
            end_seq: endSeq,
            result_payload: text,
          });
          const delivered = await deliverOpenWorkItem(channel, workItem, {
            replaceMessageId,
          });
          if (!delivered) {
            producedDeliverySucceeded = false;
          }
        } catch (err) {
          producedDeliverySucceeded = false;
          logger.warn(
            { group: group.name, chatJid, runId, err },
            'Failed to persist produced output for delivery',
          );
        } finally {
          latestProgressTextForFinal = null;
        }
      };

      const publishFailureFinal = async () => {
        if (terminalObserved()) {
          return;
        }
        await finalizeProgressMessage();
        await deliverFinalText(FAILURE_FINAL_TEXT);
      };

      const requestAgentClose = (reason: string) => {
        if (closeRequested) return;
        closeRequested = true;
        deps.queue.closeStdin(chatJid, { runId, reason });
      };

      const sendProgressMessage = async (text: string) => {
        if (!text || (text === latestProgressText && progressMessageId)) {
          return;
        }

        if (progressStartedAt === null) {
          progressStartedAt = Date.now();
        }
        latestProgressTextForFinal = text;
        latestProgressText = text;
        const rendered = renderProgressMessage(text);

        if (progressMessageId && channel.editMessage) {
          logger.info(
            {
              chatJid,
              group: group.name,
              groupFolder: group.folder,
              runId,
              progressMessageId,
              text,
            },
            'Updating tracked progress message',
          );
          await syncTrackedProgressMessage();
          visiblePhase = 'progress';
          return;
        }

        if (!channel.sendAndTrack) {
          latestProgressRendered = rendered;
          await channel.sendMessage(chatJid, rendered);
          visiblePhase = 'progress';
          return;
        }

        try {
          progressMessageId = await channel.sendAndTrack(chatJid, rendered);
        } catch (err) {
          logger.warn(
            {
              chatJid,
              group: group.name,
              groupFolder: group.folder,
              runId,
              err,
            },
            'Failed to send tracked progress message',
          );
          latestProgressRendered = rendered;
          await channel.sendMessage(chatJid, rendered);
          visiblePhase = 'progress';
          return;
        }

        if (progressMessageId) {
          logger.info(
            {
              chatJid,
              group: group.name,
              groupFolder: group.folder,
              runId,
              progressMessageId,
              text,
            },
            'Created tracked progress message',
          );
          latestProgressRendered = rendered;
          ensureProgressTicker();
          visiblePhase = 'progress';
          return;
        }

        latestProgressRendered = rendered;
        await channel.sendMessage(chatJid, rendered);
        visiblePhase = 'progress';
      };

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (hasVisibleOutput()) {
          idleTimer = null;
          return;
        }
        idleTimer = setTimeout(() => {
          logger.debug(
            { group: group.name, chatJid, runId },
            'Idle timeout, closing agent stdin',
          );
          requestAgentClose('idle-timeout');
        }, deps.idleTimeout);
      };

      resetIdleTimer();
      await channel.setTyping?.(chatJid, true);

      const output = await runAgent(
        group,
        prompt,
        chatJid,
        runId,
        async (result) => {
          if (terminalObserved()) {
            logger.info(
              {
                chatJid,
                group: group.name,
                groupFolder: group.folder,
                runId,
                resultStatus: result.status,
                resultPhase: result.phase,
              },
              'Discarding late agent output after terminal final',
            );
            return;
          }

          if (
            isClaudeCodeAgent &&
            shouldResetSessionOnAgentFailure(result) &&
            !poisonedSessionDetected
          ) {
            poisonedSessionDetected = true;
            hadError = true;
            deps.clearSession(group.folder);
            deps.queue.closeStdin(chatJid, {
              runId,
              reason: 'poisoned-session-detected',
            });
            logger.warn(
              { chatJid, group: group.name, groupFolder: group.folder, runId },
              'Detected poisoned Claude session from streamed output, forcing close',
            );
          }

          const raw =
            result.result === null || result.result === undefined
              ? null
              : typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
          const text = raw ? formatOutbound(raw) : null;

          if (raw) {
            logger.info(
              {
                chatJid,
                group: group.name,
                groupFolder: group.folder,
                runId,
                resultStatus: result.status,
                resultPhase: result.phase,
                progressMessageId,
              },
              `Agent output: ${raw.slice(0, 200)}`,
            );
          }

          if (result.phase === 'progress') {
            if (text) {
              await sendProgressMessage(text);
            }
            if (!poisonedSessionDetected) {
              resetIdleTimer();
            }
            if (result.status === 'error') {
              hadError = true;
            }
            return;
          }

          if (text) {
            await finalizeProgressMessage();
            await deliverFinalText(text);
          } else if (raw) {
            logger.info(
              {
                chatJid,
                group: group.name,
                groupFolder: group.folder,
                runId,
                resultStatus: result.status,
                resultPhase: result.phase,
                progressMessageId,
              },
              'Agent output became empty after formatting; resetting tracked progress state',
            );
            await finalizeProgressMessage();
            latestProgressTextForFinal = null;
          } else {
            await finalizeProgressMessage();
          }

          await channel.setTyping?.(chatJid, false);
          if (result.status === 'success' && !poisonedSessionDetected) {
            requestAgentClose('output-delivered-close');
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

      const settledVisiblePhase = visiblePhase as VisiblePhase;

      if (
        output === 'success' &&
        settledVisiblePhase === 'progress' &&
        !hadError &&
        latestProgressTextForFinal
      ) {
        logger.info(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
          },
          'Sending a separate final message from the last progress output after agent completion',
        );
        await finalizeProgressMessage();
        await deliverFinalText(latestProgressTextForFinal);
      } else if (
        settledVisiblePhase === 'progress' &&
        !terminalObserved() &&
        hadError
      ) {
        await publishFailureFinal();
      }

      clearProgressTicker();
      if (idleTimer) clearTimeout(idleTimer);

      if (!producedDeliverySucceeded) {
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
          visiblePhase: settledVisiblePhase,
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
                advanceLastAgentCursor(chatJid, lastIgnored.seq);
              }
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

            const needsTrigger =
              !isMainGroup && group.requiresTrigger !== false;
            if (needsTrigger) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = processableGroupMessages.some(
                (msg) =>
                  deps.triggerPattern.test(msg.content.trim()) &&
                  (msg.is_from_me ||
                    isTriggerAllowed(chatJid, msg.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }

            deps.queue.enqueueMessageCheck(chatJid, group.folder);
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
        deps.queue.enqueueMessageCheck(chatJid, group.folder);
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
        deps.queue.enqueueMessageCheck(chatJid, group.folder);
      } else if (rawPending.length > 0) {
        const endSeq = rawPending[rawPending.length - 1].seq;
        if (endSeq != null) {
          advanceLastAgentCursor(chatJid, endSeq);
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
