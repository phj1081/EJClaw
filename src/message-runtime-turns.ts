import { type AgentOutput } from './agent-runner.js';
import { getLastBotFinalMessage } from './db.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { MessageTurnController } from './message-turn-controller.js';
import {
  getEffectiveChannelLease,
  hasReviewerLease,
  resolveLeaseServiceId,
} from './service-routing.js';
import { resolvePairedTurnRunOwnership } from './paired-turn-run-ownership.js';
import { normalizeMessageForDedupe } from './router.js';
import { notifyOwnerCodexBadRequestObservation } from './session-auto-healer.js';
import type { ExecuteTurnFn } from './message-runtime-types.js';
import type {
  AgentType,
  Channel,
  NewMessage,
  OutboundAttachment,
  PairedRoomRole,
  RegisteredGroup,
} from './types.js';
import type { GroupQueue } from './group-queue.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';
import { logger } from './logger.js';

export function isDuplicateOfLastBotFinal(
  chatJid: string,
  text: string,
): boolean {
  if (!hasReviewerLease(chatJid)) {
    return false;
  }

  const lastMessages = getLastBotFinalMessage(chatJid, 'claude-code', 1);
  if (lastMessages.length === 0) {
    return false;
  }

  const lastMessage = lastMessages[0];
  const normalizedLast = normalizeMessageForDedupe(lastMessage.content);
  const normalizedCurrent = normalizeMessageForDedupe(text);

  return normalizedLast === normalizedCurrent && normalizedLast.length > 0;
}

export function labelPairedSenders(
  channels: Channel[],
  chatJid: string,
  messages: NewMessage[],
): NewMessage[] {
  if (!hasReviewerLease(chatJid)) return messages;

  const botIdToChannelName = new Map<string, string>();
  for (const ch of channels) {
    if (!ch.isConnected()) continue;
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
}

interface CreateExecuteTurnDeps {
  runAgent: (
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
  ) => Promise<'success' | 'error'>;
  assistantName: string;
  idleTimeout: number;
  failureFinalText: string;
  channels: Channel[];
  queue: GroupQueue;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  persistSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string, opts?: { allRoles?: boolean }) => void;
  deliverFinalText: (args: {
    text: string;
    attachments?: OutboundAttachment[];
    chatJid: string;
    runId: string;
    channel: Channel;
    group: RegisteredGroup;
    startSeq: number | null;
    endSeq: number | null;
    forcedAgentType?: AgentType;
    deliveryRole: PairedRoomRole | null;
    deliveryServiceId: string | null;
    replaceMessageId?: string | null;
  }) => Promise<boolean>;
  afterDeliverySuccess?: (args: {
    chatJid: string;
    runId: string;
    deliveryRole: PairedRoomRole | null;
    pairedRoom: boolean;
  }) => Promise<void>;
  recordTurnProgress: (turnId: string, progressText: string) => void;
}

export function createRunAgent(deps: {
  assistantName: string;
  queue: GroupQueue;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  persistSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string, opts?: { allRoles?: boolean }) => void;
}) {
  return async (
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
    runAgentForGroup(deps, {
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
    });
}

export function createExecuteTurn(deps: CreateExecuteTurnDeps): ExecuteTurnFn {
  return async (args) => {
    const { group, prompt, chatJid, runId, channel, startSeq, endSeq } = args;
    const isClaudeCodeAgent =
      (args.forcedAgentType ?? group.agentType ?? 'claude-code') ===
      'claude-code';
    const pairedRoom = hasReviewerLease(chatJid);
    const resolvedDeliveryRole =
      args.deliveryRole ?? args.forcedRole ?? (pairedRoom ? 'owner' : null);
    const resolvedDeliveryServiceId = resolveLeaseServiceId(
      getEffectiveChannelLease(chatJid),
      resolvedDeliveryRole ?? 'owner',
    );
    const allowProgressReplayWithoutFinal =
      args.pairedTurnIdentity?.role !== 'reviewer' &&
      args.pairedTurnIdentity?.role !== 'arbiter';
    const turnController = new MessageTurnController({
      chatJid,
      group,
      runId,
      channel,
      idleTimeout: deps.idleTimeout,
      failureFinalText: deps.failureFinalText,
      isClaudeCodeAgent,
      clearSession: () => deps.clearSession(group.folder),
      requestClose: (reason) =>
        deps.queue.closeStdin(chatJid, { runId, reason }),
      allowProgressReplayWithoutFinal,
      deliveryRole: resolvedDeliveryRole,
      deliveryServiceId: resolvedDeliveryServiceId,
      pairedTurnIdentity: args.pairedTurnIdentity ?? null,
      recordTurnProgress: (turnId, progressText) =>
        deps.recordTurnProgress(turnId, progressText),
      canDeliverFinalText: () => {
        if (!args.pairedTurnIdentity) {
          return true;
        }
        const ownership = resolvePairedTurnRunOwnership({
          turnId: args.pairedTurnIdentity.turnId,
          runId,
        });
        return ownership.state !== 'inactive';
      },
      deliverFinalText: async (text, options) => {
        try {
          return await deps.deliverFinalText({
            text,
            ...(options?.attachments?.length
              ? { attachments: options.attachments }
              : {}),
            chatJid,
            runId,
            channel,
            group,
            startSeq,
            endSeq,
            forcedAgentType: args.forcedAgentType,
            deliveryRole: resolvedDeliveryRole,
            deliveryServiceId: resolvedDeliveryServiceId,
            replaceMessageId: options?.replaceMessageId ?? null,
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
      const outputStatus = await deps.runAgent(
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

      await notifyOwnerCodexBadRequestObservation({
        chatJid,
        runId,
        groupFolder: group.folder,
        channel,
        outputStatus,
        visiblePhase,
        deliveryRole: resolvedDeliveryRole,
        agentType: args.forcedAgentType ?? group.agentType ?? 'claude-code',
        pairedTurnIdentity: args.pairedTurnIdentity ?? null,
      });

      if (deliverySucceeded) {
        await deps.afterDeliverySuccess?.({
          chatJid,
          runId,
          deliveryRole: resolvedDeliveryRole,
          pairedRoom,
        });
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
}
