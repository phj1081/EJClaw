import {
  getLastHumanMessageContent,
  getPairedTurnOutputs,
  getRecentChatMessages,
} from './db.js';
import { logger } from './logger.js';
import {
  buildArbiterPromptForTask,
  buildFinalizePendingPrompt,
  buildOwnerPendingPrompt,
  buildPairedTurnPrompt,
  buildReviewerPendingPrompt,
} from './message-runtime-prompts.js';
import {
  advanceLastAgentCursor,
  resolveCursorKey,
  resolveFollowUpDispatch,
  resolveNextTurnAction,
} from './message-runtime-rules.js';
import { type ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import { hasReviewerLease } from './service-routing.js';
import type {
  Channel,
  NewMessage,
  PairedTask,
  PairedRoomRole,
  RegisteredGroup,
} from './types.js';

export type PendingPairedTurn = {
  prompt: string;
  channel: Channel | null;
  cursor: string | number | null;
  cursorKey?: string;
  role?: 'reviewer' | 'arbiter';
} | null;

export type BotOnlyPairedFollowUpAction =
  | { kind: 'none' }
  | {
      kind: 'consume-stale-bot-message';
      task: PairedTask;
      cursor: string | number | null;
      currentStatus: PairedTask['status'];
    }
  | {
      kind: 'inline-finalize';
      task: PairedTask;
      cursor: string | number | null;
    }
  | {
      kind: 'requeue-pending-turn';
      task: PairedTask;
      cursor: string | number | null;
      cursorKey: string;
      intentKind: ScheduledPairedFollowUpIntentKind;
      nextRole: 'owner' | 'reviewer' | 'arbiter';
    };

export type QueuedTurnDispatch = {
  formatted: string;
  botOnlyFollowUpAction: BotOnlyPairedFollowUpAction;
  isBotOnlyPairedFollowUp: boolean;
  loopCursorKey: string;
  endSeq: number | null;
};

export function isBotOnlyPairedRoomTurn(
  chatJid: string,
  messages: NewMessage[],
): boolean {
  return (
    hasReviewerLease(chatJid) &&
    messages.every(
      (message) => message.is_from_me === true || !!message.is_bot_message,
    )
  );
}

export function buildPendingPairedTurn(args: {
  chatJid: string;
  timezone: string;
  task: PairedTask;
  rawMissedMessages: Array<{ seq?: number | null; timestamp?: string | null }>;
  recentHumanMessages: Parameters<
    typeof buildReviewerPendingPrompt
  >[0]['recentHumanMessages'];
  labeledRecentMessages: Parameters<
    typeof buildArbiterPromptForTask
  >[0]['labeledRecentMessages'];
  resolveChannel: (taskStatus?: string | null) => Channel | null;
}): PendingPairedTurn {
  const {
    chatJid,
    timezone,
    task,
    rawMissedMessages,
    recentHumanMessages,
    labeledRecentMessages,
    resolveChannel,
  } = args;
  const lastRaw = rawMissedMessages[rawMissedMessages.length - 1];
  const cursor = lastRaw?.seq ?? lastRaw?.timestamp ?? null;
  const taskStatus = task.status;
  const turnOutputs = getPairedTurnOutputs(task.id);
  const lastTurnOutput = turnOutputs[turnOutputs.length - 1];
  const nextTurnAction = resolveNextTurnAction({
    taskStatus,
    lastTurnOutputRole: lastTurnOutput?.role ?? null,
  });
  const recentMessages = getRecentChatMessages(chatJid, 20);
  const lastHumanMessage = getLastHumanMessageContent(chatJid);

  if (nextTurnAction.kind === 'reviewer-turn') {
    return {
      prompt: buildReviewerPendingPrompt({
        chatJid,
        timezone,
        turnOutputs,
        recentHumanMessages,
        lastHumanMessage,
      }),
      channel: resolveChannel(taskStatus),
      cursor,
      cursorKey: resolveCursorKey(chatJid, taskStatus),
      role: 'reviewer',
    };
  }

  if (nextTurnAction.kind === 'arbiter-turn') {
    return {
      prompt: buildArbiterPromptForTask({
        task,
        chatJid,
        timezone,
        turnOutputs,
        recentMessages,
        labeledRecentMessages,
      }),
      channel: resolveChannel(taskStatus),
      cursor,
      cursorKey: resolveCursorKey(chatJid, taskStatus),
      role: 'arbiter',
    };
  }

  if (nextTurnAction.kind === 'finalize-owner-turn') {
    return {
      prompt: buildFinalizePendingPrompt({ turnOutputs }),
      channel: resolveChannel(taskStatus),
      cursor,
    };
  }

  if (nextTurnAction.kind === 'owner-follow-up') {
    return {
      prompt: buildOwnerPendingPrompt({
        chatJid,
        timezone,
        turnOutputs,
        recentHumanMessages,
        lastHumanMessage,
      }),
      channel: resolveChannel(taskStatus),
      cursor,
    };
  }

  return null;
}

export async function executePendingPairedTurn(args: {
  pendingTurn: Exclude<PendingPairedTurn, null>;
  chatJid: string;
  group: RegisteredGroup;
  runId: string;
  log: typeof logger;
  saveState: () => void;
  lastAgentTimestamps: Record<string, string>;
  executeTurn: (args: {
    group: RegisteredGroup;
    prompt: string;
    chatJid: string;
    runId: string;
    channel: Channel;
    startSeq: number | null;
    endSeq: number | null;
    deliveryRole?: PairedRoomRole;
  }) => Promise<{ deliverySucceeded: boolean }>;
  getFixedRoleChannelName: (role: 'reviewer' | 'arbiter') => string;
}): Promise<boolean> {
  const {
    pendingTurn,
    chatJid,
    group,
    runId,
    log,
    saveState,
    lastAgentTimestamps,
    executeTurn,
    getFixedRoleChannelName,
  } = args;

  if (!pendingTurn.channel) {
    const missingRole = pendingTurn.role ?? 'reviewer';
    log.error(
      {
        role: missingRole,
        requiredChannel: getFixedRoleChannelName(missingRole),
      },
      'Skipping paired turn because the dedicated Discord role channel is not configured',
    );
    return false;
  }

  if (pendingTurn.cursor != null) {
    advanceLastAgentCursor(
      lastAgentTimestamps,
      saveState,
      chatJid,
      pendingTurn.cursor,
      pendingTurn.cursorKey,
    );
  }

  const { deliverySucceeded } = await executeTurn({
    group,
    prompt: pendingTurn.prompt,
    chatJid,
    runId,
    channel: pendingTurn.channel,
    deliveryRole: pendingTurn.role,
    startSeq: null,
    endSeq: null,
  });

  return deliverySucceeded;
}

export function resolveBotOnlyPairedFollowUpAction(args: {
  chatJid: string;
  task: PairedTask | null | undefined;
  isBotOnlyPairedFollowUp: boolean;
  pendingCursorSource:
    | { seq?: number | null; timestamp?: string | null }
    | undefined;
}): BotOnlyPairedFollowUpAction {
  const { chatJid, task, isBotOnlyPairedFollowUp, pendingCursorSource } = args;
  if (!task || !isBotOnlyPairedFollowUp) {
    return { kind: 'none' };
  }

  const cursor =
    pendingCursorSource?.seq ?? pendingCursorSource?.timestamp ?? null;
  const lastTurnOutput = getPairedTurnOutputs(task.id).at(-1);
  const nextTurnAction = resolveNextTurnAction({
    taskStatus: task.status,
    lastTurnOutputRole: lastTurnOutput?.role ?? null,
  });
  const dispatch = resolveFollowUpDispatch({
    source: 'bot-only-follow-up',
    nextTurnAction,
  });

  if (dispatch.kind === 'none') {
    return {
      kind: 'consume-stale-bot-message',
      task,
      cursor,
      currentStatus: task.status,
    };
  }

  if (dispatch.kind === 'inline') {
    return {
      kind: 'inline-finalize',
      task,
      cursor,
    };
  }

  if (
    dispatch.kind === 'enqueue' &&
    dispatch.queueKind === 'paired-follow-up' &&
    nextTurnAction.kind !== 'none'
  ) {
    return {
      kind: 'requeue-pending-turn',
      task,
      cursor,
      cursorKey: resolveCursorKey(chatJid, task.status),
      intentKind: nextTurnAction.kind,
      nextRole:
        nextTurnAction.kind === 'owner-follow-up'
          ? 'owner'
          : nextTurnAction.kind === 'arbiter-turn'
            ? 'arbiter'
            : 'reviewer',
    };
  }

  return { kind: 'none' };
}

export async function executeBotOnlyPairedFollowUpAction(args: {
  action: BotOnlyPairedFollowUpAction;
  chatJid: string;
  group: RegisteredGroup;
  runId: string;
  channel: Channel;
  log: typeof logger;
  saveState: () => void;
  lastAgentTimestamps: Record<string, string>;
  executeTurn: (args: {
    group: RegisteredGroup;
    prompt: string;
    chatJid: string;
    runId: string;
    channel: Channel;
    startSeq: number | null;
    endSeq: number | null;
  }) => Promise<{ deliverySucceeded: boolean }>;
  schedulePairedFollowUp: (
    task: PairedTask,
    intentKind: ScheduledPairedFollowUpIntentKind,
  ) => boolean;
  closeStdin: () => void;
}): Promise<boolean> {
  const {
    action,
    chatJid,
    group,
    runId,
    channel,
    log,
    saveState,
    lastAgentTimestamps,
    executeTurn,
    schedulePairedFollowUp,
    closeStdin,
  } = args;

  if (action.kind === 'none') {
    return false;
  }

  if (action.cursor != null) {
    advanceLastAgentCursor(
      lastAgentTimestamps,
      saveState,
      chatJid,
      action.cursor,
      action.kind === 'requeue-pending-turn' ? action.cursorKey : undefined,
    );
  }

  if (action.kind === 'consume-stale-bot-message') {
    log.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        taskId: action.task.id,
        taskStatus: action.currentStatus,
        cursor: action.cursor,
      },
      'Consumed stale bot-only paired message because no follow-up turn is pending',
    );
    return true;
  }

  if (action.kind === 'inline-finalize') {
    log.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        taskId: action.task.id,
        taskStatus: action.task.status,
        handoffMode: 'inline-finalize',
        nextRole: 'owner',
        cursor: action.cursor,
      },
      'Executing merge_ready finalize turn inline after bot-only reviewer follow-up',
    );
    const { deliverySucceeded } = await executeTurn({
      group,
      prompt: buildFinalizePendingPrompt({
        turnOutputs: getPairedTurnOutputs(action.task.id),
      }),
      chatJid,
      runId,
      channel,
      startSeq: null,
      endSeq: null,
    });
    if (!deliverySucceeded) {
      schedulePairedFollowUp(action.task, 'finalize-owner-turn');
    }
    return true;
  }

  closeStdin();
  const scheduled = schedulePairedFollowUp(action.task, action.intentKind);
  log.info(
    {
      chatJid,
      group: group.name,
      groupFolder: group.folder,
      taskId: action.task.id,
      taskStatus: action.task.status,
      handoffMode: 'requeue',
      nextRole: action.nextRole,
      intentKind: action.intentKind,
      cursor: action.cursor,
      cursorKey: action.cursorKey,
      scheduled,
    },
    scheduled
      ? 'Queued fresh paired pending turn instead of piping bot-only follow-up into the active agent'
      : 'Skipped duplicate paired pending turn requeue while task state was unchanged',
  );
  return true;
}

export function buildQueuedTurnDispatch(args: {
  chatJid: string;
  timezone: string;
  loopPendingTask: PairedTask | null | undefined;
  rawPendingMessages: NewMessage[];
  messagesToSend: NewMessage[];
  labeledMessagesToSend: NewMessage[];
  formatMessages: (messages: NewMessage[], timezone: string) => string;
}): QueuedTurnDispatch {
  const loopCursorKey = resolveCursorKey(
    args.chatJid,
    args.loopPendingTask?.status,
  );
  const formatted = args.loopPendingTask
    ? buildPairedTurnPrompt({
        taskId: args.loopPendingTask.id,
        chatJid: args.chatJid,
        timezone: args.timezone,
        missedMessages: args.messagesToSend,
        labeledFallbackMessages: args.labeledMessagesToSend,
        turnOutputs: getPairedTurnOutputs(args.loopPendingTask.id),
      })
    : args.formatMessages(args.labeledMessagesToSend, args.timezone);
  const isBotOnlyPairedFollowUp = isBotOnlyPairedRoomTurn(
    args.chatJid,
    args.messagesToSend,
  );
  const pendingCursorSource =
    args.rawPendingMessages.length > 0
      ? args.rawPendingMessages[args.rawPendingMessages.length - 1]
      : args.messagesToSend[args.messagesToSend.length - 1];
  const botOnlyFollowUpAction = resolveBotOnlyPairedFollowUpAction({
    chatJid: args.chatJid,
    task: args.loopPendingTask,
    isBotOnlyPairedFollowUp,
    pendingCursorSource,
  });

  return {
    formatted,
    botOnlyFollowUpAction,
    isBotOnlyPairedFollowUp,
    loopCursorKey,
    endSeq: args.messagesToSend[args.messagesToSend.length - 1]?.seq ?? null,
  };
}
