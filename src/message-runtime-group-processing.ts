import {
  getLatestOpenPairedTaskForChat,
  getMessagesSinceSeq,
  getOpenWorkItemForChat,
  markWorkItemDelivered,
  type WorkItem,
} from './db.js';
import {
  isSessionCommandSenderAllowed,
  SERVICE_SESSION_SCOPE,
} from './config.js';
import { resolveRuntimeAttachmentBaseDirs } from './attachment-base-dirs.js';
import { enqueueGenericFollowUpAfterDeliveryRetry as enqueueDeliveryRetryFollowUp } from './message-runtime-dispatch.js';
import { processOpenWorkItemDelivery } from './message-runtime-delivery.js';
import { handleQueuedRunGates } from './message-runtime-gating.js';
import {
  runPendingPairedTurnIfNeeded,
  runQueuedGroupTurn,
} from './message-runtime-queue.js';
import {
  advanceLastAgentCursor,
  filterLoopingPairedBotMessages,
  getProcessableMessages,
  shouldSkipBotOnlyCollaboration,
} from './message-runtime-rules.js';
import { resolveOwnerTaskForHumanMessage } from './paired-execution-context.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
import { hasReviewerLease } from './service-routing.js';
import {
  getFixedRoleChannelName,
  getMissingRoleChannelMessage,
} from './message-runtime-shared.js';
import { resolvePairedRoleChannels } from './message-runtime-role-channels.js';
import {
  getFreshHumanPreflightMessages,
  hasHumanMessageAfterWorkItem,
} from './message-runtime-preflight-messages.js';
import { deliverCanonicalOutboundMessage } from './ipc-outbound-delivery.js';
import { findChannel, formatMessages } from './router.js';
import { createScopedLogger, logger } from './logger.js';
import type { AgentOutput } from './agent-runner.js';
import type { GroupQueue, GroupRunContext } from './group-queue.js';
import type {
  ExecuteTurnFn,
  RoleToChannelMap,
} from './message-runtime-types.js';
import type {
  Channel,
  NewMessage,
  PairedTask,
  RegisteredGroup,
} from './types.js';

type RunAgentFn = (
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  runId: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
) => Promise<'success' | 'error'>;

interface ProcessGroupMessagesDeps {
  assistantName: string;
  failureFinalText: string;
  timezone: string;
  triggerPattern: RegExp;
  channels: Channel[];
  queue: Pick<GroupQueue, 'enqueueMessageCheck' | 'closeStdin' | 'killProcess'>;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  getLastAgentTimestamps: () => Record<string, string>;
  saveState: () => void;
  clearSession: (groupFolder: string, opts?: { allRoles?: boolean }) => void;
  runAgent: RunAgentFn;
  executeTurn: ExecuteTurnFn;
  hasImplicitContinuationWindow: (
    chatJid: string,
    messages: NewMessage[],
  ) => boolean;
  openContinuation: (chatJid: string) => void;
  isDuplicateOfLastBotFinal: (chatJid: string, text: string) => boolean;
  labelPairedSenders: (chatJid: string, messages: NewMessage[]) => NewMessage[];
}

interface RuntimeContext {
  chatJid: string;
  runId: string;
  group: RegisteredGroup;
  channel: Channel;
  log: ReturnType<typeof createScopedLogger>;
  roleToChannel: RoleToChannelMap;
}

interface PendingDeliveryState {
  pendingTask: PairedTask | null;
  openWorkItem: WorkItem | undefined;
}

export function createProcessGroupMessages(
  args: ProcessGroupMessagesDeps,
): (chatJid: string, context: GroupRunContext) => Promise<boolean> {
  return async (chatJid, context): Promise<boolean> => {
    const runtime = resolveRuntimeContext(args, chatJid, context.runId);
    if (!runtime) return true;

    const pendingDelivery = resolvePendingDeliveryState(args, runtime);
    const deliveryOutcome = await deliverPendingWorkItem(
      args,
      runtime,
      pendingDelivery,
    );
    if (deliveryOutcome !== null) {
      return deliveryOutcome;
    }

    return processMissedMessages(args, runtime);
  };
}

function resolveRuntimeContext(
  args: ProcessGroupMessagesDeps,
  chatJid: string,
  runId: string,
): RuntimeContext | null {
  const group = args.getRoomBindings()[chatJid];
  if (!group) return null;
  const log = createScopedLogger({
    chatJid,
    groupName: group.name,
    groupFolder: group.folder,
    runId,
  });

  const channel = findChannel(args.channels, chatJid);
  if (!channel) {
    log.warn('No channel owns JID, skipping messages');
    return null;
  }

  const {
    roleToChannel,
    reviewerChannelName,
    foundReviewerChannel,
    arbiterChannelName,
    foundArbiterChannel,
  } = resolvePairedRoleChannels(args.channels, channel);
  if (hasReviewerLease(chatJid)) {
    log.info(
      {
        reviewerChannelName,
        foundChannel: foundReviewerChannel?.name ?? null,
        arbiterChannelName,
        foundArbiterChannel: foundArbiterChannel?.name ?? null,
        availableChannels: args.channels.map((c) => c.name),
      },
      'Paired room reviewer/arbiter channel resolution',
    );
  }

  return { chatJid, runId, group, channel, log, roleToChannel };
}

function resolvePendingDeliveryState(
  args: ProcessGroupMessagesDeps,
  runtime: RuntimeContext,
): PendingDeliveryState {
  const { chatJid, channel, group, log } = runtime;
  let pendingTask: PairedTask | null = hasReviewerLease(chatJid)
    ? (getLatestOpenPairedTaskForChat(chatJid) ?? null)
    : null;
  let openWorkItem = getOpenWorkItemForChat(chatJid, SERVICE_SESSION_SCOPE);
  if (openWorkItem?.delivery_role !== 'owner' || !pendingTask) {
    return { pendingTask, openWorkItem };
  }

  const freshHumanMessages = getFreshHumanPreflightMessages({
    chatJid,
    channel,
    lastAgentTimestamps: args.getLastAgentTimestamps(),
    assistantName: args.assistantName,
    failureFinalText: args.failureFinalText,
  });
  if (pendingTask.status === 'merge_ready' && freshHumanMessages.length > 0) {
    const resolvedTask = resolveOwnerTaskForHumanMessage({
      group,
      chatJid,
      existingTask: pendingTask,
    });
    pendingTask = resolvedTask.task ?? null;
    if (resolvedTask.supersededTask) {
      markWorkItemDelivered(openWorkItem.id);
      log.info(
        {
          chatJid,
          workItemId: openWorkItem.id,
          supersededTaskId: resolvedTask.supersededTask.id,
          replacementTaskId: resolvedTask.task?.id ?? null,
        },
        'Suppressed stale owner delivery retry because a new human message superseded the merge_ready task',
      );
      openWorkItem = undefined;
    }
  } else if (
    pendingTask.status === 'active' &&
    hasHumanMessageAfterWorkItem(openWorkItem, freshHumanMessages)
  ) {
    markWorkItemDelivered(openWorkItem.id);
    log.info(
      {
        chatJid,
        workItemId: openWorkItem.id,
        taskId: pendingTask.id,
        taskStatus: pendingTask.status,
        workItemEndSeq: openWorkItem.end_seq ?? null,
        freshHumanMessageCount: freshHumanMessages.length,
      },
      'Suppressed stale owner delivery retry because a new human message arrived while the paired task was still active',
    );
    openWorkItem = undefined;
  }

  return { pendingTask, openWorkItem };
}

async function deliverPendingWorkItem(
  args: ProcessGroupMessagesDeps,
  runtime: RuntimeContext,
  pendingDelivery: PendingDeliveryState,
): Promise<boolean | null> {
  const { chatJid, runId, group, channel, roleToChannel, log } = runtime;
  const openWorkItemOutcome = await processOpenWorkItemDelivery({
    chatJid,
    runId,
    openWorkItem: pendingDelivery.openWorkItem,
    pendingTask: pendingDelivery.pendingTask,
    channel,
    roleToChannel,
    log,
    attachmentBaseDirs: resolveRuntimeAttachmentBaseDirs(group),
    isPairedRoom: hasReviewerLease(chatJid),
    getMissingRoleChannelMessage,
    isDuplicateOfLastBotFinal: args.isDuplicateOfLastBotFinal,
    openContinuation: args.openContinuation,
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
        enqueueMessageCheck: () => args.queue.enqueueMessageCheck(chatJid),
      }),
  });
  if (openWorkItemOutcome === 'failed') {
    return false;
  }
  if (openWorkItemOutcome === 'delivered') {
    return true;
  }
  return null;
}

async function processMissedMessages(
  args: ProcessGroupMessagesDeps,
  runtime: RuntimeContext,
): Promise<boolean> {
  while (true) {
    const rawMissedMessages = getMessagesSinceSeq(
      runtime.chatJid,
      args.getLastAgentTimestamps()[runtime.chatJid] || '0',
      args.assistantName,
    );
    const missedMessages = filterLoopingPairedBotMessages(
      runtime.chatJid,
      getProcessableMessages(
        runtime.chatJid,
        rawMissedMessages,
        runtime.channel,
      ),
      args.failureFinalText,
    );

    if (missedMessages.length === 0) {
      return handleNoMissedMessages(args, runtime, rawMissedMessages);
    }

    const pendingTurnOutcome = await runBotOnlyPendingTurn(
      args,
      runtime,
      rawMissedMessages,
      missedMessages,
    );
    if (pendingTurnOutcome !== null) {
      return pendingTurnOutcome;
    }

    if (shouldSkipBotOnlyCollaboration(runtime.chatJid, missedMessages)) {
      advancePastBotOnlyCollaboration(args, runtime, missedMessages);
      return true;
    }

    const gateOutcome = await runQueuedRunGates(args, runtime, missedMessages);
    if (gateOutcome !== null) {
      return gateOutcome;
    }

    return runQueuedGroupTurn({
      chatJid: runtime.chatJid,
      group: runtime.group,
      runId: runtime.runId,
      log: runtime.log,
      timezone: args.timezone,
      missedMessages,
      task: hasReviewerLease(runtime.chatJid)
        ? (getLatestOpenPairedTaskForChat(runtime.chatJid) ?? null)
        : undefined,
      roleToChannel: runtime.roleToChannel,
      ownerChannel: runtime.channel,
      lastAgentTimestamps: args.getLastAgentTimestamps(),
      saveState: args.saveState,
      executeTurn: args.executeTurn,
      getFixedRoleChannelName,
      labelPairedSenders: args.labelPairedSenders,
      formatMessages,
    });
  }
}

async function handleNoMissedMessages(
  args: ProcessGroupMessagesDeps,
  runtime: RuntimeContext,
  rawMissedMessages: NewMessage[],
): Promise<boolean> {
  const pendingTurnOutcome = await runPendingPairedTurnIfNeeded({
    chatJid: runtime.chatJid,
    group: runtime.group,
    runId: runtime.runId,
    log: runtime.log,
    timezone: args.timezone,
    task: hasReviewerLease(runtime.chatJid)
      ? getLatestOpenPairedTaskForChat(runtime.chatJid)
      : null,
    rawMissedMessages,
    saveState: args.saveState,
    lastAgentTimestamps: args.getLastAgentTimestamps(),
    executeTurn: args.executeTurn,
    getFixedRoleChannelName,
    roleToChannel: runtime.roleToChannel,
    labelPairedSenders: args.labelPairedSenders,
    mode: 'idle',
  });
  if (pendingTurnOutcome !== null) {
    return pendingTurnOutcome;
  }

  const lastIgnored = rawMissedMessages[rawMissedMessages.length - 1];
  if (lastIgnored) {
    advanceLastAgentCursor(
      args.getLastAgentTimestamps(),
      args.saveState,
      runtime.chatJid,
      lastIgnored.timestamp,
    );
  }
  return true;
}

function runBotOnlyPendingTurn(
  args: ProcessGroupMessagesDeps,
  runtime: RuntimeContext,
  rawMissedMessages: NewMessage[],
  missedMessages: NewMessage[],
): Promise<boolean | null> {
  return runPendingPairedTurnIfNeeded({
    chatJid: runtime.chatJid,
    group: runtime.group,
    runId: runtime.runId,
    log: runtime.log,
    timezone: args.timezone,
    task: hasReviewerLease(runtime.chatJid)
      ? getLatestOpenPairedTaskForChat(runtime.chatJid)
      : null,
    rawMissedMessages,
    saveState: args.saveState,
    lastAgentTimestamps: args.getLastAgentTimestamps(),
    executeTurn: args.executeTurn,
    getFixedRoleChannelName,
    roleToChannel: runtime.roleToChannel,
    labelPairedSenders: args.labelPairedSenders,
    mode: 'bot-only',
    missedMessages,
  });
}

function advancePastBotOnlyCollaboration(
  args: ProcessGroupMessagesDeps,
  runtime: RuntimeContext,
  missedMessages: NewMessage[],
): void {
  const lastMessage = missedMessages[missedMessages.length - 1];
  if (lastMessage?.seq != null) {
    advanceLastAgentCursor(
      args.getLastAgentTimestamps(),
      args.saveState,
      runtime.chatJid,
      lastMessage.seq,
    );
  }
  runtime.log.info(
    'Skipping bot-only collaboration because no recent human message exists',
  );
}

async function runQueuedRunGates(
  args: ProcessGroupMessagesDeps,
  runtime: RuntimeContext,
  missedMessages: NewMessage[],
): Promise<boolean | null> {
  const gateResult = await handleQueuedRunGates({
    chatJid: runtime.chatJid,
    group: runtime.group,
    runId: runtime.runId,
    missedMessages,
    triggerPattern: args.triggerPattern,
    timezone: args.timezone,
    hasImplicitContinuationWindow: args.hasImplicitContinuationWindow,
    sessionCommandDeps: {
      sendMessage: (text) =>
        deliverSessionCommandMessage(args, runtime.chatJid, text),
      setTyping: (typing) =>
        runtime.channel.setTyping?.(runtime.chatJid, typing) ??
        Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        args.runAgent(
          runtime.group,
          prompt,
          runtime.chatJid,
          runtime.runId,
          onOutput,
        ),
      closeStdin: () =>
        args.queue.closeStdin(runtime.chatJid, {
          reason: 'session-command',
        }),
      clearSession: (opts) => args.clearSession(runtime.group.folder, opts),
      advanceCursor: (cursorOrTimestamp) => {
        advanceLastAgentCursor(
          args.getLastAgentTimestamps(),
          args.saveState,
          runtime.chatJid,
          cursorOrTimestamp,
        );
      },
      formatMessages,
      isAdminSender: (msg) => isSessionCommandSenderAllowed(msg.sender),
      canSenderInteract: () => true,
      resetPairedTask: () => completePairedTaskAsStopped(runtime.chatJid),
      killProcess: () => args.queue.killProcess(runtime.chatJid),
    },
  });
  return gateResult.handled ? gateResult.success : null;
}

function completePairedTaskAsStopped(chatJid: string): void {
  if (!hasReviewerLease(chatJid)) return;
  const task = getLatestOpenPairedTaskForChat(chatJid);
  if (!task) return;

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

async function deliverSessionCommandMessage(
  deps: Pick<ProcessGroupMessagesDeps, 'channels' | 'getRoomBindings'>,
  chatJid: string,
  text: string,
): Promise<void> {
  await deliverCanonicalOutboundMessage(
    { jid: chatJid, text },
    {
      channels: deps.channels,
      roomBindings: deps.getRoomBindings,
      log: logger,
    },
  );
}
