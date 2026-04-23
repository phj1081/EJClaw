import { getPairedTurnOutputs, getRecentChatMessages } from './db.js';
import { logger } from './logger.js';
import {
  buildArbiterPromptForTask,
  buildPairedTurnPrompt,
} from './message-runtime-prompts.js';
import { resolveOwnerTaskForHumanMessage } from './paired-execution-context.js';
import {
  buildPendingPairedTurn,
  executePendingPairedTurn,
  isBotOnlyPairedRoomTurn,
} from './message-runtime-flow.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import { resolveStoredVisibleVerdict } from './paired-verdict.js';
import {
  advanceLastAgentCursor,
  resolveActiveRole,
  resolveCursorKeyForRole,
  resolveQueuedPairedTurnRole,
  resolveQueuedTurnRole,
} from './message-runtime-rules.js';
import { claimPairedTurnExecution } from './paired-follow-up-scheduler.js';
import type {
  ExecuteTurnFn,
  RoleToChannelMap,
} from './message-runtime-types.js';
import type {
  Channel,
  NewMessage,
  PairedTask,
  PairedTurnReservationIntentKind,
  RegisteredGroup,
} from './types.js';

function resolveQueuedTurnReservationIntent(args: {
  task: PairedTask;
  turnRole: 'owner' | 'reviewer' | 'arbiter';
  hasHumanMessage: boolean;
}): PairedTurnReservationIntentKind {
  if (args.turnRole === 'reviewer') {
    return 'reviewer-turn';
  }
  if (args.turnRole === 'arbiter') {
    return 'arbiter-turn';
  }
  if (args.hasHumanMessage) {
    return 'owner-turn';
  }
  if (args.task.status === 'merge_ready') {
    return 'finalize-owner-turn';
  }
  return 'owner-follow-up';
}

export async function runPendingPairedTurnIfNeeded(args: {
  chatJid: string;
  group: RegisteredGroup;
  runId: string;
  log: typeof logger;
  timezone: string;
  task: PairedTask | null | undefined;
  rawMissedMessages: NewMessage[];
  saveState: () => void;
  lastAgentTimestamps: Record<string, string>;
  executeTurn: ExecuteTurnFn;
  getFixedRoleChannelName: (role: 'reviewer' | 'arbiter') => string;
  roleToChannel: RoleToChannelMap;
  labelPairedSenders: (chatJid: string, messages: NewMessage[]) => NewMessage[];
  mode: 'idle' | 'bot-only';
  missedMessages?: NewMessage[];
}): Promise<boolean | null> {
  const { chatJid, task, roleToChannel } = args;
  if (!task) {
    return null;
  }

  if (
    args.mode === 'bot-only' &&
    (!args.missedMessages ||
      !isBotOnlyPairedRoomTurn(chatJid, args.missedMessages))
  ) {
    return null;
  }

  const recentMessages = getRecentChatMessages(chatJid, 20);
  const recentHumanMessages = recentMessages.filter(
    (message) => !message.is_bot_message,
  );
  const labeledRecentMessages = args.labelPairedSenders(
    chatJid,
    recentMessages,
  );
  const pendingTurn = buildPendingPairedTurn({
    chatJid,
    timezone: args.timezone,
    task,
    rawMissedMessages: args.rawMissedMessages,
    recentHumanMessages,
    labeledRecentMessages,
    resolveChannel: (taskStatus) =>
      roleToChannel[resolveActiveRole(taskStatus)] ?? null,
  });

  if (!pendingTurn) {
    return null;
  }

  if (pendingTurn.channel) {
    const claimed = claimPairedTurnExecution({
      chatJid,
      runId: args.runId,
      task,
      intentKind: pendingTurn.intentKind,
    });
    if (!claimed) {
      args.log.info(
        {
          chatJid,
          taskId: task.id,
          taskStatus: task.status,
          taskUpdatedAt: task.updated_at,
          intentKind: pendingTurn.intentKind,
        },
        'Skipped paired pending turn because the task revision was already claimed elsewhere',
      );
      return true;
    }
  }

  return executePendingPairedTurn({
    pendingTurn,
    chatJid,
    group: args.group,
    runId: args.runId,
    log: args.log,
    saveState: args.saveState,
    lastAgentTimestamps: args.lastAgentTimestamps,
    executeTurn: args.executeTurn,
    getFixedRoleChannelName: args.getFixedRoleChannelName,
  });
}

export async function runQueuedGroupTurn(args: {
  chatJid: string;
  group: RegisteredGroup;
  runId: string;
  log: typeof logger;
  timezone: string;
  missedMessages: NewMessage[];
  task: PairedTask | null | undefined;
  roleToChannel: RoleToChannelMap;
  ownerChannel: Channel;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  executeTurn: ExecuteTurnFn;
  getFixedRoleChannelName: (role: 'reviewer' | 'arbiter') => string;
  labelPairedSenders: (chatJid: string, messages: NewMessage[]) => NewMessage[];
  formatMessages: (messages: NewMessage[], timezone: string) => string;
}): Promise<boolean> {
  const { chatJid, group, runId, log, missedMessages, task, roleToChannel } =
    args;
  let currentTask = task;
  const hasHumanMsg = task
    ? !missedMessages.every(
        (message) => message.is_from_me === true || !!message.is_bot_message,
      )
    : !isBotOnlyPairedRoomTurn(chatJid, missedMessages);
  let fallbackMessages = missedMessages;
  if (currentTask && hasHumanMsg) {
    const resolvedTask = resolveOwnerTaskForHumanMessage({
      group,
      chatJid,
      existingTask: currentTask,
    });
    currentTask = resolvedTask.task;
    if (resolvedTask.supersededTask) {
      fallbackMessages = getRecentChatMessages(chatJid, 20).filter(
        (message) => !message.is_bot_message,
      );
    }
  }
  const taskStatus = currentTask?.status;
  const turnOutputs = currentTask ? getPairedTurnOutputs(currentTask.id) : [];
  const lastTurnOutputRole = currentTask
    ? (turnOutputs.at(-1)?.role ?? null)
    : null;
  const lastTurnOutputVerdict = currentTask
    ? resolveStoredVisibleVerdict({
        verdict: turnOutputs.at(-1)?.verdict ?? null,
        outputText: turnOutputs.at(-1)?.output_text ?? null,
      })
    : null;
  const turnRole = currentTask
    ? hasHumanMsg
      ? resolveQueuedTurnRole({
          taskStatus,
          hasHumanMessage: true,
        })
      : resolveQueuedPairedTurnRole({
          taskStatus,
          hasHumanMessage: false,
          lastTurnOutputRole,
          lastTurnOutputVerdict,
        })
    : 'owner';
  if (!turnRole) {
    const endSeq = missedMessages[missedMessages.length - 1]?.seq ?? null;
    if (endSeq !== null) {
      advanceLastAgentCursor(
        args.lastAgentTimestamps,
        args.saveState,
        chatJid,
        endSeq,
        resolveCursorKeyForRole(chatJid, resolveActiveRole(taskStatus)),
      );
    }
    log.info(
      {
        chatJid,
        taskId: task?.id ?? null,
        taskStatus,
        lastTurnOutputRole,
      },
      'Skipped queued paired turn because the latest persisted turn already closed the pending handoff',
    );
    return true;
  }
  const turnChannel =
    turnRole === 'owner' ? args.ownerChannel : roleToChannel[turnRole];
  const cursorKey = resolveCursorKeyForRole(chatJid, turnRole);
  const forcedRole = currentTask ? turnRole : undefined;
  const queuedIntentKind = currentTask
    ? resolveQueuedTurnReservationIntent({
        task: currentTask,
        turnRole,
        hasHumanMessage: hasHumanMsg,
      })
    : null;
  const pairedTurnIdentity =
    currentTask && queuedIntentKind
      ? buildPairedTurnIdentity({
          taskId: currentTask.id,
          taskUpdatedAt: currentTask.updated_at,
          intentKind: queuedIntentKind,
          role: turnRole,
        })
      : undefined;

  let prompt: string;
  if (turnRole === 'arbiter' && currentTask) {
    const recentMessages = getRecentChatMessages(chatJid, 20);
    prompt = buildArbiterPromptForTask({
      task: currentTask,
      chatJid,
      timezone: args.timezone,
      turnOutputs,
      recentMessages,
      labeledRecentMessages: args.labelPairedSenders(chatJid, recentMessages),
    });
  } else if (currentTask) {
    prompt = buildPairedTurnPrompt({
      taskId: currentTask.id,
      chatJid,
      timezone: args.timezone,
      missedMessages,
      labeledFallbackMessages: args.labelPairedSenders(
        chatJid,
        fallbackMessages,
      ),
      turnOutputs,
    });
  } else {
    prompt = args.formatMessages(
      args.labelPairedSenders(chatJid, missedMessages),
      args.timezone,
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
        requiredChannel: args.getFixedRoleChannelName(missingRole),
      },
      'Skipping paired-room run because the dedicated Discord role channel is not configured',
    );
    return false;
  }

  if (currentTask) {
    const claimed = claimPairedTurnExecution({
      chatJid,
      runId,
      task: currentTask,
      intentKind: queuedIntentKind!,
    });
    if (!claimed) {
      log.info(
        {
          taskId: currentTask.id,
          taskStatus,
          taskUpdatedAt: currentTask.updated_at,
          intentKind: queuedIntentKind,
          turnRole,
        },
        'Skipped queued paired turn because the task revision was already claimed elsewhere',
      );
      return true;
    }
  }

  if (endSeq !== null) {
    advanceLastAgentCursor(
      args.lastAgentTimestamps,
      args.saveState,
      chatJid,
      endSeq,
      cursorKey,
    );
  }

  const { deliverySucceeded, visiblePhase } = await args.executeTurn({
    group,
    prompt,
    chatJid,
    runId,
    channel: turnChannel,
    deliveryRole: currentTask ? turnRole : undefined,
    startSeq,
    endSeq,
    hasHumanMessage: hasHumanMsg,
    forcedRole,
    pairedTurnIdentity,
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
